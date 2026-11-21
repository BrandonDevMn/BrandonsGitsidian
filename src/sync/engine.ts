// The sync engine. Pure orchestration over a VaultIO and a GitHubClient, so it can be
// tested without Obsidian. Specs: 02, 03, 04, 05, 06, 08, 09.

import { gitBlobSha, isTextPath, utf8 } from "../core/blob";
import { classifyAll, type Action } from "../core/classify";
import { addEntries, type ConflictEntry } from "../core/conflictLog";
import { commitMessage, type PushedChange } from "../core/commitMessage";
import { mergeText } from "../core/merge";
import { CONFLICT_LOG_PATH, isExcluded, isValidOnIos } from "../core/paths";
import { isMassDeletion, vaultLooksWiped } from "../core/safety";
import type { Logger } from "../core/logger";
import { GitHubError, type GitHubClient } from "../github/client";

export interface FileStat {
  path: string;
  size: number;
  mtime: number;
}

/** What the engine needs from the vault. In the plugin this wraps Obsidian's Vault API. */
export interface VaultIO {
  list(): Promise<FileStat[]>;
  read(path: string): Promise<Uint8Array>;
  /** Create or overwrite; creates parent folders. Returns the new stat. */
  write(path: string, bytes: Uint8Array): Promise<FileStat>;
  /** Move to trash per the user's Obsidian setting. */
  trash(path: string): Promise<void>;
}

export interface IndexEntry {
  sha: string;
  size: number;
  mtime: number;
}

export interface SyncState {
  repoKey: string; // owner/repo@branch the index belongs to
  baseCommit: string | null;
  index: Record<string, IndexEntry>;
}

export type FirstSyncChoice = "github" | "vault" | "merge";

export interface SyncOptions {
  trigger: string;
  pushOnly?: boolean; // quick push when the app is hidden (specs/07)
  dryRun?: boolean; // preview (specs/08)
  firstSyncChoice?: FirstSyncChoice;
  confirmMassDeletion?: boolean;
  restoreWipedVault?: boolean;
}

export type Decision =
  | { kind: "first-sync" }
  | { kind: "mass-deletion"; paths: string[] }
  | { kind: "vault-wiped" }
  | { kind: "history-rewritten" }
  | { kind: "branch-missing" };

export interface SyncResult {
  status: "ok" | "nothing-to-do" | "needs-decision" | "error" | "skipped";
  decision?: Decision;
  error?: { kind: string; message: string };
  pulled: string[];
  pushed: string[];
  trashed: string[];
  merged: string[];
  conflicts: string[];
  skipped: { path: string; reason: string }[];
  remoteCommits: { message: string; author: string }[];
  preview?: { path: string; action: string }[];
  newHead?: string;
}

export interface EngineConfig {
  branch: string;
  excludes: string[];
  maxFileBytes: number;
  device: string;
  now?: () => Date;
}

const MAX_PUSH_RETRIES = 3;
export const PUSH_BATCH = 40;

export class SyncEngine {
  constructor(
    private vault: VaultIO,
    private gh: GitHubClient,
    private cfg: EngineConfig,
    private log: Logger,
    private loadState: () => SyncState,
    private saveState: (s: SyncState) => Promise<void>,
  ) {}

  async sync(opts: SyncOptions): Promise<SyncResult> {
    const run = this.log.startRun();
    const started = Date.now();
    this.log.info(`Sync #${run} started (trigger: ${opts.trigger}${opts.pushOnly ? ", push only" : ""}${opts.dryRun ? ", preview" : ""})`);
    try {
      return await this.attempts(opts, started);
    } finally {
      this.log.endRun();
    }
  }

  private async attempts(opts: SyncOptions, started: number): Promise<SyncResult> {
    for (let attempt = 1; attempt <= MAX_PUSH_RETRIES + 1; attempt++) {
      try {
        const r = await this.once(opts);
        this.log.info(
          `Sync finished: ${r.status}${r.decision ? ` (${r.decision.kind})` : ""}; pulled ${r.pulled.length}, pushed ${r.pushed.length}, trashed ${r.trashed.length}, merged ${r.merged.length}, conflicts ${r.conflicts.length}, skipped ${r.skipped.length}; took ${Date.now() - started} ms`,
        );
        return r;
      } catch (e) {
        if (e instanceof GitHubError && e.kind === "not-fast-forward" && attempt <= MAX_PUSH_RETRIES) {
          this.log.warn(`GitHub changed while pushing (attempt ${attempt}); pulling and rebuilding the commit`);
          continue;
        }
        const r = empty("error");
        if (e instanceof GitHubError) {
          r.error = { kind: e.kind, message: friendly(e) };
          this.log.error(`Sync stopped: ${e.kind}: ${e.message}`);
        } else {
          r.error = { kind: "internal", message: (e as Error).message };
          this.log.error(`Sync stopped by an internal error: ${(e as Error).stack ?? e}`);
        }
        if (e instanceof GitHubError && e.kind === "not-fast-forward") {
          r.error = { kind: e.kind, message: "GitHub kept changing. Try again in a minute." };
        }
        return r;
      }
    }
    return empty("error");
  }

  private async once(opts: SyncOptions): Promise<SyncResult> {
    const result = empty("ok");
    let state = this.loadState();

    // ---- remote head -------------------------------------------------------
    let t0 = Date.now();
    this.log.info(`Step 1/5: checking GitHub branch "${this.cfg.branch}"`);
    const head = await this.gh.branchHead(this.cfg.branch);
    if (head === null) {
      this.log.error(`Branch "${this.cfg.branch}" not found on GitHub`);
      return { ...result, status: "needs-decision", decision: { kind: "branch-missing" } };
    }
    const remoteEmpty = head === "empty";
    this.log.info(`Remote head: ${remoteEmpty ? "(empty repository)" : short(head)}; base: ${state.baseCommit ? short(state.baseCommit) : "(none, first sync)"}`);

    // ---- push-only fast path (app going to background) --------------------
    if (opts.pushOnly && (remoteEmpty || head !== state.baseCommit)) {
      this.log.info("Quick push skipped: GitHub has new changes, so a full sync is needed first (it'll run when you come back)");
      return { ...result, status: "skipped" };
    }

    // ---- local snapshot ----------------------------------------------------
    const oversized = new Set<string>();
    const local = new Map<string, string>();
    const localStat = new Map<string, FileStat>();
    t0 = Date.now();
    this.log.info("Step 2/5: scanning the vault");
    let hashed = 0;
    let excludedLocal = 0;
    for (const f of await this.vault.list()) {
      if (isExcluded(f.path, this.cfg.excludes)) {
        excludedLocal++;
        continue;
      }
      if (f.size > this.cfg.maxFileBytes) {
        oversized.add(f.path);
        result.skipped.push({ path: f.path, reason: `${mb(f.size)} MB is over the ${mb(this.cfg.maxFileBytes)} MB limit` });
        this.log.warn(`Skipping ${f.path}: ${mb(f.size)} MB is over the limit`);
        continue;
      }
      localStat.set(f.path, f);
      const cached = state.index[f.path];
      if (cached && cached.size === f.size && cached.mtime === f.mtime) {
        local.set(f.path, cached.sha);
      } else {
        local.set(f.path, await gitBlobSha(await this.vault.read(f.path)));
        hashed++;
        this.log.debug(`Read and hashed ${f.path} (${kb(f.size)}): ${cached ? "size or date changed since last sync" : "not seen before"}`);
      }
    }
    this.log.info(
      `Vault: ${local.size} tracked files; ${hashed} read and hashed, ${local.size - hashed} unchanged since last sync${excludedLocal ? `; ${excludedLocal} excluded` : ""} (${Date.now() - t0} ms)`,
    );

    // ---- remote snapshot ---------------------------------------------------
    const remote = new Map<string, string>();
    let remoteTree: string | null = null;
    t0 = Date.now();
    this.log.info("Step 3/5: reading GitHub's files");
    if (remoteEmpty) {
      this.log.info("GitHub: the repository is empty");
    } else {
      if (state.baseCommit === head) {
        for (const [p, e] of Object.entries(state.index)) remote.set(p, e.sha);
        this.log.info(`GitHub hasn't changed since the last sync (${short(head)}), so its file list was reused`);
      } else {
        if (state.baseCommit && !(await this.gh.isAncestor(state.baseCommit, head))) {
          this.log.error("GitHub's history no longer contains the last synced commit");
          return { ...result, status: "needs-decision", decision: { kind: "history-rewritten" } };
        }
        remoteTree = await this.gh.commitTree(head);
        for (const e of await this.gh.listTree(remoteTree)) {
          if (isExcluded(e.path, this.cfg.excludes)) continue;
          if (!isValidOnIos(e.path)) {
            result.skipped.push({ path: e.path, reason: "name isn't valid on iOS" });
            this.log.warn(`Skipping ${e.path}: its name isn't valid on iOS`);
            continue;
          }
          if (e.size > this.cfg.maxFileBytes) {
            oversized.add(e.path);
            result.skipped.push({ path: e.path, reason: `${mb(e.size)} MB is over the limit` });
            this.log.warn(`Skipping remote ${e.path}: ${mb(e.size)} MB is over the limit`);
            continue;
          }
          remote.set(e.path, e.sha);
        }
        this.log.info(`GitHub: ${remote.size} files at ${short(head)} (${Date.now() - t0} ms)`);
        if (state.baseCommit) {
          try {
            result.remoteCommits = (await this.gh.commitsBetween(state.baseCommit, head)).map((c) => ({
              message: c.message.split("\n")[0] ?? "",
              author: c.author,
            }));
            for (const c of result.remoteCommits) this.log.info(`New on GitHub: "${c.message}" by ${c.author}`);
          } catch (e) {
            this.log.debug(`Couldn't list new commits: ${(e as Error).message}`);
          }
        }
      }
    }

    // ---- base snapshot -----------------------------------------------------
    const base = new Map<string, string>();
    const firstSync = state.baseCommit === null;
    const conflictEntries: ConflictEntry[] = [];
    if (firstSync) {
      if (local.size > 0 && remote.size > 0) {
        if (!opts.firstSyncChoice) {
          this.log.info("First sync with files on both sides; waiting for a choice");
          return { ...result, status: "needs-decision", decision: { kind: "first-sync" } };
        }
        this.log.info(`First sync choice: ${opts.firstSyncChoice}`);
        for (const [p, l] of local) {
          const r = remote.get(p);
          if (r === undefined || r === l) continue;
          if (opts.firstSyncChoice === "github") base.set(p, l); // remote differs -> pull update (logged below)
          if (opts.firstSyncChoice === "vault") base.set(p, r); // local differs -> push update
          // "merge": no base -> both-added conflict -> GitHub wins, logged
        }
      }
    } else {
      for (const [p, e] of Object.entries(state.index)) base.set(p, e.sha);
    }
    for (const p of oversized) {
      base.delete(p);
      local.delete(p);
      remote.delete(p);
    }

    // ---- safety: wiped vault -----------------------------------------------
    if (!firstSync && vaultLooksWiped(base.size, local.size)) {
      if (!opts.restoreWipedVault) {
        this.log.error("Vault looks empty but the index lists files; nothing will be deleted on GitHub");
        return { ...result, status: "needs-decision", decision: { kind: "vault-wiped" } };
      }
      this.log.warn("Restoring a wiped vault from GitHub");
      base.clear();
    }

    // ---- classify ----------------------------------------------------------
    const actions = classifyAll({ base, local, remote });
    this.log.info(`Step 4/5: planning — ${planSummary(actions)}`);
    const changed = [...actions].filter(([, a]) => a.kind !== "unchanged");
    for (const [p, a] of changed) {
      const line = `Classified ${p}: ${describe(a)}`;
      if (changed.length <= 50 && a.kind !== "same") this.log.info(line);
      else this.log.debug(line);
    }

    if (opts.dryRun) {
      result.preview = [...actions].filter(([, a]) => a.kind !== "unchanged" && a.kind !== "same").map(([path, a]) => ({ path, action: describe(a) }));
      return { ...result, status: result.preview.length ? "ok" : "nothing-to-do" };
    }

    // ---- safety: mass deletion ---------------------------------------------
    const deletions = [...actions].filter(([, a]) => (a.kind === "push" || a.kind === "pull") && a.change === "delete").map(([p]) => p);
    if (isMassDeletion(deletions.length, Math.max(base.size, local.size)) && !opts.confirmMassDeletion) {
      this.log.warn(`Sync would delete ${deletions.length} files; asking first`);
      return { ...result, status: "needs-decision", decision: { kind: "mass-deletion", paths: deletions } };
    }

    // ---- apply pulls and conflicts -----------------------------------------
    const nextIndex = new Map<string, IndexEntry>();
    const toPush: PushedChange[] = [];
    const now = this.cfg.now ?? (() => new Date());
    const pullTotal = [...actions].filter(([, a]) => a.kind === "pull" || a.kind === "conflict").length;
    let pullN = 0;
    t0 = Date.now();
    this.log.info(`Step 5/5: applying changes${pullTotal ? ` (${pullTotal} from GitHub)` : ""}`);

    for (const [path, a] of actions) {
      const stat = localStat.get(path);
      const localSha = local.get(path);
      const remoteSha = remote.get(path);
      switch (a.kind) {
        case "unchanged":
        case "same":
          if (localSha && stat) nextIndex.set(path, { sha: localSha, size: stat.size, mtime: stat.mtime });
          break;
        case "pull": {
          if (opts.pushOnly) break;
          pullN++;
          if (a.change === "delete") {
            await this.vault.trash(path);
            result.trashed.push(path);
            this.log.info(`Pulling ${pullN}/${pullTotal}: moved ${path} to the trash (deleted on GitHub)`);
          } else {
            const bytes = await this.gh.getBlob(remoteSha as string);
            const st = await this.vault.write(path, bytes);
            nextIndex.set(path, { sha: remoteSha as string, size: st.size, mtime: st.mtime });
            result.pulled.push(path);
            this.log.info(`Pulling ${pullN}/${pullTotal}: ${path} (${a.change === "add" ? "new" : "updated"}, ${kb(bytes.byteLength)})`);
            if (firstSync && opts.firstSyncChoice === "github" && base.has(path)) {
              conflictEntries.push(await this.entry(path, "edit discarded", localSha, now()));
            }
          }
          break;
        }
        case "push":
          toPush.push({ path, change: a.change });
          if (localSha && stat) nextIndex.set(path, { sha: localSha, size: stat.size, mtime: stat.mtime });
          break;
        case "conflict":
          pullN++;
          this.log.info(`Pulling ${pullN}/${pullTotal}: ${path} changed on both sides; resolving`);
          await this.resolveConflict(path, base.get(path), localSha, remoteSha, stat, nextIndex, toPush, conflictEntries, result, now());
          break;
      }
    }

    // ---- conflict log --------------------------------------------------------
    if (conflictEntries.length) {
      let existing: string | null = null;
      try {
        existing = utf8.decode(await this.vault.read(CONFLICT_LOG_PATH));
      } catch {
        existing = null;
      }
      const doc = utf8.encode(addEntries(existing, conflictEntries));
      const st = await this.vault.write(CONFLICT_LOG_PATH, doc);
      const sha = await gitBlobSha(doc);
      nextIndex.set(CONFLICT_LOG_PATH, { sha, size: st.size, mtime: st.mtime });
      toPush.push({ path: CONFLICT_LOG_PATH, change: remote.has(CONFLICT_LOG_PATH) ? "update" : "add" });
      this.log.info(`Wrote ${conflictEntries.length} conflict log entr${conflictEntries.length === 1 ? "y" : "ies"}`);
    }

    // ---- push ----------------------------------------------------------------
    let newHead = remoteEmpty ? null : head;
    const uniquePush = dedupe(toPush);
    if (pullTotal) this.log.info(`Applied ${pullTotal} change${pullTotal === 1 ? "" : "s"} from GitHub (${Date.now() - t0} ms)`);
    if (uniquePush.length) {
      t0 = Date.now();
      newHead = await this.push(uniquePush, remoteEmpty ? null : head, remoteTree, remote, nextIndex, firstSync && remote.size === 0, state.repoKey);
      result.pushed = uniquePush.map((c) => c.path);
      this.log.info(`Sent ${uniquePush.length} change${uniquePush.length === 1 ? "" : "s"} to GitHub (${Date.now() - t0} ms)`);
    }

    if (!result.pulled.length && !result.pushed.length && !result.trashed.length && !result.conflicts.length && !result.merged.length) {
      result.status = "nothing-to-do";
    }

    // ---- save state atomically (specs/08) ----------------------------------
    if (newHead) {
      state = { repoKey: state.repoKey, baseCommit: newHead, index: Object.fromEntries(nextIndex) };
      await this.saveState(state);
      result.newHead = newHead;
      this.log.debug(`Saved state: base ${short(newHead)}, ${nextIndex.size} files`);
    }
    return result;
  }

  private async entry(path: string, what: ConflictEntry["what"], localSha: string | undefined, when: Date): Promise<ConflictEntry> {
    const e: ConflictEntry = { when, device: this.cfg.device, path, what };
    if (localSha === undefined) return e;
    try {
      const bytes = await this.vault.read(path);
      if (isTextPath(path)) e.discardedText = utf8.decode(bytes);
      else e.discardedSize = bytes.byteLength;
    } catch {
      /* already gone */
    }
    return e;
  }

  private async resolveConflict(
    path: string,
    baseSha: string | undefined,
    localSha: string | undefined,
    remoteSha: string | undefined,
    stat: FileStat | undefined,
    nextIndex: Map<string, IndexEntry>,
    toPush: PushedChange[],
    entries: ConflictEntry[],
    result: SyncResult,
    when: Date,
  ): Promise<void> {
    // Both sides have content: try a line merge for text with a known base.
    if (localSha && remoteSha && baseSha && isTextPath(path)) {
      const [b, mine, theirs] = await Promise.all([this.gh.getBlob(baseSha), this.vault.read(path), this.gh.getBlob(remoteSha)]);
      const merged = mergeText(utf8.decode(b), utf8.decode(mine), utf8.decode(theirs));
      if (merged.ok) {
        const bytes = utf8.encode(merged.text);
        const st = await this.vault.write(path, bytes);
        nextIndex.set(path, { sha: await gitBlobSha(bytes), size: st.size, mtime: st.mtime });
        toPush.push({ path, change: "update" });
        result.merged.push(path);
        this.log.info(`Merged edits from both sides in ${path}`);
        return;
      }
      this.log.info(`Edits overlap in ${path}; GitHub's version wins`);
    }

    result.conflicts.push(path);
    if (localSha && remoteSha) {
      entries.push(await this.entry(path, localSha && !baseSha ? "new file discarded" : "edit discarded", localSha, when));
      const bytes = await this.gh.getBlob(remoteSha);
      const st = await this.vault.write(path, bytes);
      nextIndex.set(path, { sha: remoteSha, size: st.size, mtime: st.mtime });
      this.log.warn(`Conflict in ${path}: kept GitHub's version, logged mine`);
    } else if (localSha && !remoteSha) {
      entries.push(await this.entry(path, "edit discarded, file deleted on GitHub", localSha, when));
      await this.vault.trash(path);
      result.trashed.push(path);
      this.log.warn(`Conflict in ${path}: deleted on GitHub, so my edits were trashed and logged`);
    } else if (!localSha && remoteSha) {
      entries.push({ when, device: this.cfg.device, path, what: "deletion undone" });
      const bytes = await this.gh.getBlob(remoteSha);
      const st = await this.vault.write(path, bytes);
      nextIndex.set(path, { sha: remoteSha, size: st.size, mtime: st.mtime });
      this.log.warn(`Conflict in ${path}: edited on GitHub, so my deletion was undone`);
    }
    void stat;
  }

  private async push(
    changes: PushedChange[],
    head: string | null,
    knownTree: string | null,
    remote: Map<string, string>,
    nextIndex: Map<string, IndexEntry>,
    initial: boolean,
    repoKey: string,
  ): Promise<string> {
    const message = commitMessage(changes, this.cfg.device, initial);
    let parent = head;
    let pending = [...changes];
    const total = changes.length;
    let sent = 0;

    if (parent === null) {
      // Empty repository: the Git Database API needs one commit first (specs/02, 05).
      const first = pending.find((c) => c.change !== "delete");
      if (!first) throw new GitHubError("other", "Nothing to upload to an empty repository");
      this.log.info(`Uploading ${++sent}/${total}: ${first.path} (first file initialises the empty repository)`);
      parent = await this.gh.initEmptyRepo(this.cfg.branch, first.path, await this.vault.read(first.path), message);
      pending = pending.filter((c) => c !== first);
      knownTree = null;
      await this.saveProgress(parent, nextIndex, pending, remote, repoKey);
    }

    // Big pushes go in batches, each its own commit, with progress saved after each,
    // so an iOS suspension mid-upload doesn't lose the work (specs/08).
    const batches: PushedChange[][] = [];
    for (let i = 0; i < pending.length; i += PUSH_BATCH) batches.push(pending.slice(i, i + PUSH_BATCH));
    for (const [bi, batch] of batches.entries()) {
      const entries: { path: string; sha: string | null }[] = [];
      for (const c of batch) {
        sent++;
        if (c.change === "delete") {
          if (remote.has(c.path)) {
            entries.push({ path: c.path, sha: null });
            this.log.info(`Uploading ${sent}/${total}: delete ${c.path}`);
          } else this.log.info(`Uploading ${sent}/${total}: ${c.path} is already gone on GitHub; nothing to send`);
          continue;
        }
        const bytes = await this.vault.read(c.path);
        const sha = await this.gh.createBlob(bytes);
        const expected = nextIndex.get(c.path)?.sha;
        if (expected && expected !== sha) this.log.warn(`Blob SHA mismatch for ${c.path}: local ${short(expected)}, GitHub ${short(sha)}`);
        entries.push({ path: c.path, sha });
        this.log.info(`Uploading ${sent}/${total}: ${c.path} (${c.change === "add" ? "new" : "updated"}, ${kb(bytes.byteLength)})`);
      }
      if (!entries.length) continue;
      const baseTree = knownTree ?? (await this.gh.commitTree(parent));
      const tree = await this.gh.createTree(baseTree, entries);
      const batchMsg = batches.length > 1 ? `${message.split("\n")[0]} (part ${bi + 1} of ${batches.length})\n\n${commitMessage(batch, this.cfg.device).split("\n\n")[1] ?? ""}` : message;
      const commit = await this.gh.createCommit(batchMsg, tree, [parent]);
      await this.gh.updateBranch(this.cfg.branch, commit);
      this.log.info(
        `Committed ${batches.length > 1 ? `batch ${bi + 1}/${batches.length} ` : ""}as ${short(commit)}: ${batchMsg.split("\n")[0]}`,
      );
      parent = commit;
      knownTree = tree;
      for (const c of batch) {
        if (c.change === "delete") remote.delete(c.path);
        else remote.set(c.path, nextIndex.get(c.path)?.sha ?? "");
      }
      const rest = batches.slice(bi + 1).flat();
      if (rest.length) await this.saveProgress(parent, nextIndex, rest, remote, repoKey);
    }
    return parent;
  }

  /** Saves a base + index that's consistent mid-push: not-yet-pushed paths keep GitHub's version as their base. */
  private async saveProgress(
    commit: string,
    nextIndex: Map<string, IndexEntry>,
    notYetPushed: PushedChange[],
    remote: Map<string, string>,
    repoKey: string,
  ): Promise<void> {
    const idx = new Map(nextIndex);
    for (const c of notYetPushed) {
      const r = remote.get(c.path);
      if (r) idx.set(c.path, { sha: r, size: -1, mtime: -1 });
      else idx.delete(c.path);
    }
    await this.saveState({ repoKey, baseCommit: commit, index: Object.fromEntries(idx) });
    this.log.debug(`Saved progress at ${short(commit)}; ${notYetPushed.length} change(s) still to send`);
  }
}

function empty(status: SyncResult["status"]): SyncResult {
  return { status, pulled: [], pushed: [], trashed: [], merged: [], conflicts: [], skipped: [], remoteCommits: [] };
}

function dedupe(changes: PushedChange[]): PushedChange[] {
  const m = new Map<string, PushedChange>();
  for (const c of changes) m.set(c.path, c);
  return [...m.values()];
}

function describe(a: Action): string {
  if (a.kind === "push" || a.kind === "pull") return `${a.kind} ${a.change}`;
  return a.kind;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${mb(bytes)} MB`;
}

function planSummary(actions: Map<string, Action>): string {
  const n = { pull: 0, push: 0, del: 0, conflict: 0, same: 0, unchanged: 0 };
  for (const a of actions.values()) {
    if (a.kind === "pull" || a.kind === "push") {
      if (a.change === "delete") n.del++;
      else n[a.kind]++;
    } else n[a.kind]++;
  }
  const parts = [`${n.pull} to pull`, `${n.push} to push`, `${n.del} to delete`, `${n.conflict} changed on both sides`, `${n.unchanged + n.same} unchanged`];
  return parts.join(", ");
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "");
}

export function friendly(e: GitHubError): string {
  switch (e.kind) {
    case "network":
      return "Lost connection. Will finish next time.";
    case "auth":
      return "GitHub token expired or invalid. Update it in BrandonGitsidian settings.";
    case "forbidden":
      return 'This token can\'t write to the repo. Give it "Contents: Read and write" access.';
    case "not-found":
      return "Can't see the repository. Check the name and the token's repo access.";
    case "rate-limited":
      return `GitHub rate limit reached. Try again in about ${Math.ceil(e.retryAfterSec / 60)} min.`;
    default:
      return e.message;
  }
}
