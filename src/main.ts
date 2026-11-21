import { apiVersion, Modal, normalizePath, Platform, Plugin, setIcon, TAbstractFile, TFile, type App } from "obsidian";
import { CONFLICT_LOG_PATH, isExcluded } from "./core/paths";
import { formatLog, Logger, type LogEntry } from "./core/logger";
import { utf8 } from "./core/blob";
import { GitHubClient, GitHubError } from "./github/client";
import { friendly, SyncEngine, type FirstSyncChoice, type SyncOptions, type SyncResult, type SyncState } from "./sync/engine";
import { AwayTracker, Countdown, ErrorDeduper, SingleFlight, summaryNotice, type RunRequest } from "./sync/scheduler";
import { obsidianHttp } from "./obsidian/http";
import { ObsidianVaultIO } from "./obsidian/vaultIO";
import { BrandonGitsidianSettingTab, choose, DEFAULT_SETTINGS, notice, type Settings } from "./obsidian/settings";
import { LOG_VIEW, LogView } from "./obsidian/logView";

const LOG_NOTE_PATH = "_brandon-gitsidian/detailed log.md";
const RETURN_AFTER_MS = 30_000;
const MAX_HISTORY = 50;

interface HistoryItem {
  t: number;
  trigger: string;
  status: string;
  error?: string;
  pulled: string[];
  pushed: string[];
  trashed: string[];
  conflicts: string[];
  commits: { message: string; author: string }[];
}

interface PluginData {
  settings: Settings;
  state: SyncState;
  log: LogEntry[];
  history: HistoryItem[];
}

type RibbonState = "idle" | "running" | "dirty" | "error" | "paused";

export default class BrandonGitsidianPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  state: SyncState = { repoKey: "", baseCommit: null, index: {} };
  history: HistoryItem[] = [];
  log!: Logger;

  private ribbon!: HTMLElement;
  private runner!: SingleFlight<SyncResult | null>;
  private typing!: Countdown;
  private away = new AwayTracker();
  private errors = new ErrorDeduper();
  private dirty = false;
  private lastError: string | null = null;
  private applying = false;
  private lastSyncAt = 0;
  private intervalId: number | null = null;
  private logSaveTimer: number | null = null;

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
    this.state = data.state ?? { repoKey: this.repoKey(), baseCommit: null, index: {} };
    this.history = data.history ?? [];
    this.log = new Logger(data.log ?? []);
    this.log.debugEnabled = this.settings.logDebug;
    this.log.info(`Plugin loaded (v${this.manifest.version}, Obsidian API ${apiVersion}, ${Platform.isIosApp ? "iOS" : Platform.isMobile ? "mobile" : "desktop"})`);
    this.log.onChange(() => this.scheduleLogSave());

    this.runner = new SingleFlight(
      (req) => this.runSync(req),
      () => navigator.onLine !== false,
      (msg) => this.log.info(msg),
    );
    this.runner.paused = this.settings.paused;
    this.typing = new Countdown(() => void this.runner.request({ trigger: "after edits" }));

    this.registerView(LOG_VIEW, (leaf) => new LogView(leaf, this));
    this.addSettingTab(new BrandonGitsidianSettingTab(this.app, this));

    this.ribbon = this.addRibbonIcon("refresh-cw", "BrandonGitsidian: sync now", () => void this.syncNow("ribbon"));
    this.setRibbon(this.settings.paused ? "paused" : "idle");

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow("command") });
    this.addCommand({ id: "preview-sync", name: "Preview sync", callback: () => void this.preview() });
    this.addCommand({ id: "toggle-pause", name: "Pause or resume sync", callback: () => void this.togglePause() });
    this.addCommand({ id: "open-detailed-log", name: "Open detailed log", callback: () => void this.openLogView() });
    this.addCommand({ id: "open-sync-log", name: "Open sync log", callback: () => new HistoryModal(this.app, this).open() });
    this.addCommand({ id: "save-log-to-note", name: "Save detailed log to note", callback: () => void this.saveLogNote(this.log.list()) });

    // obsidian://brandon-gitsidian?action=sync (iOS Shortcuts, specs/07)
    this.registerObsidianProtocolHandler("brandon-gitsidian", (params) => {
      this.log.info(`Opened by URL with action "${params.action ?? ""}"`);
      if (params.action === "sync" || !params.action) void this.syncNow("shortcut URL");
    });

    this.app.workspace.onLayoutReady(() => {
      // Register after layout so the initial "create" event per file isn't treated as an edit (specs/07).
      const onChange = (f: TAbstractFile) => this.onVaultChange(f);
      this.registerEvent(this.app.vault.on("modify", onChange));
      this.registerEvent(this.app.vault.on("create", onChange));
      this.registerEvent(this.app.vault.on("delete", onChange));
      this.registerEvent(this.app.vault.on("rename", onChange));
      if (this.settings.syncOnStartup) void this.runner.request({ trigger: "startup" });
    });

    this.registerDomEvent(document, "visibilitychange", () => this.onVisibility());
    this.restartInterval();
  }

  onunload(): void {
    this.log.info("Plugin unloaded");
    this.typing?.cancel();
    void this.saveAll();
  }

  // ---- triggers --------------------------------------------------------------------

  private onVaultChange(f: TAbstractFile): void {
    if (this.applying || !(f instanceof TFile)) return;
    if (isExcluded(f.path, this.settings.excludes) || f.path === LOG_NOTE_PATH) return;
    this.dirty = true;
    if (!this.runner.busy) this.setRibbon("dirty");
    if (this.settings.pushAfterEdits) {
      const first = !this.typing.pending;
      this.typing.restart(this.settings.pushDelaySeconds * 1000);
      // Log the first edit of a burst at info, the rest at debug, so the log stays readable.
      const msg = `Edit detected in ${f.path}; push scheduled in ${this.settings.pushDelaySeconds}s after typing stops`;
      if (first) this.log.info(msg);
      else this.log.debug(msg);
    } else {
      this.log.debug(`Edit detected in ${f.path}; will sync on the next trigger`);
    }
  }

  private onVisibility(): void {
    if (document.hidden) {
      this.away.hidden();
      this.log.info("Obsidian went to the background");
      if (this.dirty) {
        this.typing.cancel();
        this.log.info("Unsynced edits: trying a quick push before iOS suspends the app");
        void this.runner.request({ trigger: "leaving app", pushOnly: true });
      }
      void this.saveAll();
    } else {
      const away = this.away.visible();
      this.log.info(`Obsidian came back after ${Math.round(away / 1000)}s`);
      if (this.settings.syncOnReturn && away >= RETURN_AFTER_MS) void this.runner.request({ trigger: "app returned" });
      else if (this.settings.syncOnReturn) this.log.debug(`No sync on return: away less than ${RETURN_AFTER_MS / 1000}s`);
    }
  }

  restartInterval(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    this.intervalId = null;
    if (this.settings.intervalMinutes <= 0) return;
    this.intervalId = window.setInterval(() => {
      if (document.hidden) return; // paused in the background (specs/07)
      if (Date.now() - this.lastSyncAt >= this.settings.intervalMinutes * 60_000) void this.runner.request({ trigger: "timer" });
    }, 30_000);
    this.registerInterval(this.intervalId);
  }

  async syncNow(trigger: string): Promise<void> {
    this.typing.cancel();
    if (navigator.onLine === false) {
      notice("You're offline. Try again when you're connected.");
      return;
    }
    if (this.runner.busy) notice("A sync is already running; another will follow it.");
    await this.runner.request({ trigger }, true);
  }

  private async togglePause(): Promise<void> {
    this.settings.paused = !this.settings.paused;
    this.runner.paused = this.settings.paused;
    this.log.info(this.settings.paused ? "Automatic sync paused" : "Automatic sync resumed");
    this.setRibbon(this.settings.paused ? "paused" : this.dirty ? "dirty" : "idle");
    notice(this.settings.paused ? "Automatic sync paused. \"Sync now\" still works." : "Automatic sync resumed.");
    await this.saveAll();
  }

  // ---- running a sync --------------------------------------------------------------

  private engine(): SyncEngine | null {
    const s = this.settings;
    const token = s.tokenSecretId ? this.app.secretStorage.getSecret(s.tokenSecretId) : null;
    if (!token) {
      this.log.error(s.tokenSecretId ? `No token found in the keychain under "${s.tokenSecretId}"` : "No GitHub token chosen in settings");
      this.reportError("no-token", "Pick a GitHub token in BrandonGitsidian settings first.");
      return null;
    }
    const client = new GitHubClient({ owner: s.owner, repo: s.repo, token, http: obsidianHttp, log: this.log });
    return new SyncEngine(
      new ObsidianVaultIO(this.app),
      client,
      { branch: s.branch, excludes: s.excludes, maxFileBytes: s.maxFileMB * 1024 * 1024, device: s.deviceName },
      this.log,
      () => this.state,
      async (st) => {
        this.state = st;
        await this.saveAll(); // one write: base + index together (specs/08)
      },
    );
  }

  private async runSync(req: RunRequest, extra: Partial<SyncOptions> = {}): Promise<SyncResult | null> {
    if (this.state.baseCommit && this.state.repoKey !== this.repoKey()) {
      const ok = await choose(
        this.app,
        "Repository changed",
        `You're now syncing ${this.repoKey()}. The next sync will be treated as a first sync.`,
        [{ label: "Start fresh with the new repository", value: "yes" }],
      );
      if (!ok) return null;
      await this.resetSyncState();
    }
    const engine = this.engine();
    if (!engine) return null;

    this.setRibbon("running");
    this.applying = true;
    this.dirty = false;
    let result: SyncResult;
    try {
      result = await engine.sync({ trigger: req.trigger, pushOnly: req.pushOnly, ...extra });
    } finally {
      this.applying = false;
    }

    if (result.status === "needs-decision" && result.decision) {
      const next = await this.decide(result);
      if (next) return this.runSync(req, { ...extra, ...next });
    }
    if (result.status === "skipped" && req.pushOnly) this.dirty = true;
    await this.afterSync(req, result);
    return result;
  }

  private async decide(result: SyncResult): Promise<Partial<SyncOptions> | null> {
    const d = result.decision!;
    this.setRibbon("idle");
    switch (d.kind) {
      case "first-sync":
      case "history-rewritten": {
        const choice = await choose(
          this.app,
          d.kind === "first-sync" ? "First sync" : "GitHub's history changed",
          "Your vault and GitHub both have notes. How should they be combined? Nothing changes until you choose.",
          [
            { label: "Merge both", value: "merge", desc: "Identical files are linked. Where they differ, GitHub's version wins and yours is logged." },
            { label: "Use GitHub's version", value: "github", desc: "Download everything; differing local files are overwritten and logged." },
            { label: "Use this vault", value: "vault", desc: "Upload everything; differing GitHub files are overwritten in a commit." },
          ],
        );
        if (!choice) return null;
        if (d.kind === "history-rewritten") await this.resetSyncState();
        return { firstSyncChoice: choice as FirstSyncChoice };
      }
      case "mass-deletion": {
        const preview = d.paths.slice(0, 15).join("\n") + (d.paths.length > 15 ? `\n…and ${d.paths.length - 15} more` : "");
        const ok = await choose(this.app, `Delete ${d.paths.length} files?`, `This sync would delete:\n${preview}`, [
          { label: "Delete them", value: "yes" },
          { label: "Not now", value: "no", desc: "Nothing is deleted. You'll be asked again on the next sync." },
        ]);
        return ok === "yes" ? { confirmMassDeletion: true } : null;
      }
      case "vault-wiped": {
        const ok = await choose(
          this.app,
          "Your vault looks empty",
          "Nothing was deleted on GitHub. Restore your notes from GitHub?",
          [{ label: "Restore from GitHub", value: "yes" }],
        );
        return ok ? { restoreWipedVault: true } : null;
      }
      case "branch-missing":
        this.reportError("branch-missing", `Branch "${this.settings.branch}" not found. Pick an existing branch, or leave the repo empty.`);
        return null;
    }
  }

  private async afterSync(req: RunRequest, r: SyncResult): Promise<void> {
    this.lastSyncAt = Date.now();
    if (r.status === "error" && r.error) {
      this.reportError(r.error.kind, r.error.message);
      if (r.error.kind === "auth") {
        this.runner.paused = true; // until the token is fixed (specs/09)
        this.log.warn("Automatic sync paused until the token is fixed");
      }
    } else {
      this.lastError = null;
      this.errors.shouldNotify(null);
      if (!this.settings.paused) this.runner.paused = false;
      const text = summaryNotice({ pulled: r.pulled.length, pushed: r.pushed.length, trashed: r.trashed.length, merged: r.merged.length, conflicts: r.conflicts.length });
      if (text) notice(text, () => new HistoryModal(this.app, this).open());
      for (const s of r.skipped) if (s.reason.includes("limit")) notice(`Skipped ${s.path} (${s.reason}).`);
    }
    if (r.status !== "skipped") {
      this.history.unshift({
        t: Date.now(),
        trigger: req.trigger,
        status: r.decision ? `${r.status} (${r.decision.kind})` : r.status,
        error: r.error?.message,
        pulled: r.pulled,
        pushed: r.pushed,
        trashed: r.trashed,
        conflicts: r.conflicts,
        commits: r.remoteCommits,
      });
      this.history.length = Math.min(this.history.length, MAX_HISTORY);
    }
    this.setRibbon(this.lastError ? "error" : this.settings.paused ? "paused" : this.dirty ? "dirty" : "idle");
    if (this.settings.autoSaveLogNote && (r.pulled.length || r.pushed.length || r.error)) await this.saveLogNote(this.log.list(), false);
    await this.saveAll();
  }

  private reportError(kind: string, message: string): void {
    this.lastError = message;
    this.setRibbon("error");
    if (this.errors.shouldNotify(kind)) notice(message, () => void this.openLogView(), 10000);
  }

  async testConnection(): Promise<void> {
    const s = this.settings;
    const token = s.tokenSecretId ? this.app.secretStorage.getSecret(s.tokenSecretId) : null;
    if (!token) return notice("Pick a GitHub token in settings first.");
    if (navigator.onLine === false) return notice("You're offline. Try again when you're connected.");
    const client = new GitHubClient({ owner: s.owner, repo: s.repo, token, http: obsidianHttp, log: this.log });
    try {
      const info = await client.repoInfo();
      if (!info.canPush) return notice('This token is read-only. Give it "Contents: Read and write" access.');
      const head = await client.branchHead(s.branch);
      if (head === null) return notice(`Branch "${s.branch}" not found. Pick an existing branch or leave the repo empty.`);
      notice(`Connected to ${s.owner}/${s.repo} (${s.branch}). ${client.rate.remaining ?? "?"} API requests left this hour.`);
      this.log.info(`Test connection OK${head === "empty" ? " (repository is empty)" : ""}`);
    } catch (e) {
      const msg =
        e instanceof GitHubError
          ? e.kind === "auth"
            ? "GitHub didn't accept this token. Create a new one and try again."
            : e.kind === "not-found"
              ? `Can't see ${s.owner}/${s.repo}. Check the name and the token's repo access.`
              : friendly(e)
          : (e as Error).message;
      this.log.error(`Test connection failed: ${msg}`);
      notice(msg);
    }
  }

  private async preview(): Promise<void> {
    const engine = this.engine();
    if (!engine) return;
    const r = await engine.sync({ trigger: "preview", dryRun: true });
    new PreviewModal(this.app, r).open();
  }

  // ---- state, log, UI ------------------------------------------------------------------

  repoKey(): string {
    return `${this.settings.owner}/${this.settings.repo}@${this.settings.branch}`;
  }

  async resetSyncState(): Promise<void> {
    this.state = { repoKey: this.repoKey(), baseCommit: null, index: {} };
    this.log.warn(`Sync state reset for ${this.state.repoKey}`);
    await this.saveAll();
  }

  lastSyncText(): string {
    const last = this.history.find((h) => h.status === "ok" || h.status === "nothing-to-do");
    return last ? new Date(last.t).toLocaleString() : "never";
  }

  logHeader(): string {
    return `BrandonGitsidian ${this.manifest.version} · Obsidian API ${apiVersion} · ${Platform.isIosApp ? "iOS" : Platform.isMobile ? "mobile" : "desktop"} · ${this.repoKey()}`;
  }

  async saveLogNote(entries: LogEntry[], announce = true): Promise<void> {
    const path = normalizePath(LOG_NOTE_PATH);
    const text = "```\n" + formatLog(entries, this.logHeader()) + "\n```\n";
    const io = new ObsidianVaultIO(this.app);
    await io.write(path, utf8.encode(text));
    if (announce) notice(`Saved log to ${path}`);
  }

  async openLogView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(LOG_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getLeaf(true);
    if (!existing) await leaf.setViewState({ type: LOG_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private setRibbon(state: RibbonState): void {
    if (!this.ribbon) return;
    this.ribbon.removeClass("bgs-ribbon-running", "bgs-ribbon-dirty");
    const icon = state === "error" ? "alert-triangle" : state === "paused" ? "pause-circle" : "refresh-cw";
    setIcon(this.ribbon, icon);
    if (state === "running") this.ribbon.addClass("bgs-ribbon-running");
    if (state === "dirty") this.ribbon.addClass("bgs-ribbon-dirty");
    this.ribbon.setAttr("aria-label", `BrandonGitsidian: ${state === "error" && this.lastError ? this.lastError : state}`);
  }

  private scheduleLogSave(): void {
    if (this.logSaveTimer !== null) return;
    this.logSaveTimer = window.setTimeout(() => {
      this.logSaveTimer = null;
      void this.saveAll();
    }, 5000);
  }

  async saveAll(): Promise<void> {
    const data: PluginData = { settings: this.settings, state: this.state, log: this.log.all(), history: this.history };
    await this.saveData(data);
  }
}

class HistoryModal extends Modal {
  constructor(app: App, private plugin: BrandonGitsidianPlugin) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText("Sync log");
    const { contentEl } = this;
    if (!this.plugin.history.length) contentEl.createEl("p", { text: "No syncs yet." });
    for (const h of this.plugin.history) {
      const box = contentEl.createDiv({ cls: "bgs-history" });
      box.createEl("strong", { text: `${new Date(h.t).toLocaleString()} · ${h.trigger} · ${h.status}` });
      if (h.error) box.createEl("div", { text: h.error, cls: "bgs-error" });
      for (const c of h.commits) box.createEl("div", { text: `GitHub: "${c.message}" by ${c.author}` });
      const files: [string, string[]][] = [["pulled", h.pulled], ["pushed", h.pushed], ["trashed", h.trashed], ["conflict", h.conflicts]];
      for (const [label, list] of files) {
        for (const p of list) {
          const a = box.createEl("a", { text: `${label}: ${p}` });
          a.addEventListener("click", () => {
            this.close();
            void this.app.workspace.openLinkText(p, "");
          });
          box.createEl("br");
        }
      }
    }
    if (this.plugin.history.length) {
      const link = contentEl.createEl("a", { text: `Conflict log: ${CONFLICT_LOG_PATH}` });
      link.addEventListener("click", () => {
        this.close();
        void this.app.workspace.openLinkText(CONFLICT_LOG_PATH, "");
      });
    }
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

class PreviewModal extends Modal {
  constructor(app: App, private r: SyncResult) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText("Sync preview");
    if (this.r.error) this.contentEl.createEl("p", { text: this.r.error.message });
    else if (this.r.decision) this.contentEl.createEl("p", { text: `Needs a decision first: ${this.r.decision.kind}` });
    else if (!this.r.preview?.length) this.contentEl.createEl("p", { text: "Nothing to sync." });
    for (const p of this.r.preview ?? []) this.contentEl.createEl("div", { text: `${p.action}: ${p.path}` });
    this.contentEl.createEl("p", { text: "Nothing was changed.", cls: "bgs-log-empty" });
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
