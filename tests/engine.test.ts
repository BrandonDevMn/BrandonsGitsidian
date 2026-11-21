import { beforeEach, describe, expect, it } from "vitest";
import { SyncEngine, type SyncState, type SyncOptions } from "../src/sync/engine";
import { GitHubClient, type Http } from "../src/github/client";
import { Logger, formatLog } from "../src/core/logger";
import { DEFAULT_EXCLUDES, CONFLICT_LOG_PATH } from "../src/core/paths";
import { FakeGitHub } from "./fakeGitHub";
import { MemVault } from "./memVault";

const DEVICE = "Brandon's iPhone";
const MB = 1024 * 1024;

function setup(opts: { maxFileBytes?: number } = {}) {
  const gh = new FakeGitHub();
  const vault = new MemVault();
  const log = new Logger();
  let state: SyncState = { repoKey: "BrandonDevMn/Claudian@main", baseCommit: null, index: {} };
  const saves: SyncState[] = [];
  const client = new GitHubClient({ owner: "BrandonDevMn", repo: "Claudian", token: "good-token", http: gh.http, log, sleep: async () => {}, writeGapMs: 0 });
  const engine = new SyncEngine(
    vault,
    client,
    { branch: "main", excludes: DEFAULT_EXCLUDES, maxFileBytes: opts.maxFileBytes ?? 20 * MB, device: DEVICE, now: () => new Date(2026, 10, 21, 14, 5) },
    log,
    () => state,
    async (s) => {
      state = s;
      saves.push(s);
    },
  );
  const sync = (o: Partial<SyncOptions> = {}) => engine.sync({ trigger: "test", ...o });
  return { gh, vault, log, sync, saves, getState: () => state, client };
}

/** Repo with notes, synced once into the vault. */
async function synced(files: Record<string, string>) {
  const t = setup();
  t.gh.commitFiles("main", files);
  const r = await t.sync();
  expect(r.status).toBe("ok");
  return t;
}

describe("02 first sync", () => {
  it("empty vault downloads everything", async () => {
    const t = setup();
    t.gh.commitFiles("main", { "a.md": "A", "games/x/b.md": "B", ".obsidian/app.json": "{}" });
    const r = await t.sync();
    expect(r.pulled.sort()).toEqual(["a.md", "games/x/b.md"]);
    expect(t.vault.text("games/x/b.md")).toBe("B");
    expect(t.vault.files.has(".obsidian/app.json")).toBe(false);
    expect(t.getState().baseCommit).toBe(t.gh.refs.get("main"));
    expect(Object.keys(t.getState().index).sort()).toEqual(["a.md", "games/x/b.md"]);
  });

  it("empty repo gets an initial upload", async () => {
    const t = setup();
    t.vault.set("a.md", "A");
    t.vault.set("b.md", "B");
    t.vault.set(".obsidian/workspace.json", "{}");
    const r = await t.sync();
    expect(r.pushed.sort()).toEqual(["a.md", "b.md"]);
    expect(t.gh.files()).toEqual({ "a.md": "A", "b.md": "B" });
    expect(t.gh.headMessage()).toBe(`BrandonGitsidian: initial upload from ${DEVICE}`);
  });

  it("asks how to combine when both sides have files", async () => {
    const t = setup();
    t.gh.commitFiles("main", { "timeline.md": "remote" });
    t.vault.set("timeline.md", "local");
    const r = await t.sync();
    expect(r).toMatchObject({ status: "needs-decision", decision: { kind: "first-sync" } });
    expect(t.vault.text("timeline.md")).toBe("local");
    expect(t.saves).toHaveLength(0);
  });

  it("merge: identical files link without transfer, differences go GitHub's way and are logged", async () => {
    const t = setup();
    t.gh.commitFiles("main", { "same.md": "S", "diff.md": "remote", "remote-only.md": "R" });
    t.vault.set("same.md", "S");
    t.vault.set("diff.md", "local");
    t.vault.set("local-only.md", "L");
    const before = t.gh.requests.length;
    const r = await t.sync({ firstSyncChoice: "merge" });
    expect(r.pulled).toContain("remote-only.md");
    expect(r.pushed).toContain("local-only.md");
    expect(r.conflicts).toEqual(["diff.md"]);
    expect(t.vault.text("diff.md")).toBe("remote");
    expect(t.vault.text(CONFLICT_LOG_PATH)).toContain("> local");
    expect(t.gh.requests.slice(before).some((q) => q.url.includes("same.md"))).toBe(false);
  });

  it("vault choice uploads local versions over GitHub's", async () => {
    const t = setup();
    t.gh.commitFiles("main", { "diff.md": "remote", "remote-only.md": "R" });
    t.vault.set("diff.md", "local");
    await t.sync({ firstSyncChoice: "vault" });
    expect(t.gh.files()["diff.md"]).toBe("local");
    expect(t.vault.text("remote-only.md")).toBe("R");
  });

  it("github choice downloads GitHub's versions and logs what was overwritten", async () => {
    const t = setup();
    t.gh.commitFiles("main", { "diff.md": "remote" });
    t.vault.set("diff.md", "local");
    t.vault.set("mine.md", "M");
    await t.sync({ firstSyncChoice: "github" });
    expect(t.vault.text("diff.md")).toBe("remote");
    expect(t.gh.files()["mine.md"]).toBe("M");
    expect(t.vault.text(CONFLICT_LOG_PATH)).toContain("[[diff]]");
  });

  it("an interrupted first sync resumes without re-downloading", async () => {
    const t = setup();
    t.gh.commitFiles("main", { "a.md": "A", "b.md": "B" });
    t.vault.set("a.md", "A"); // pretend this one landed before iOS suspended us
    const r = await t.sync({ firstSyncChoice: "merge" });
    expect(r.pulled).toEqual(["b.md"]);
  });
});

describe("03 change detection", () => {
  it("doesn't read the tree when the head hasn't moved", async () => {
    const t = await synced({ "a.md": "A" });
    const before = t.gh.requests.length;
    const r = await t.sync();
    expect(r.status).toBe("nothing-to-do");
    const urls = t.gh.requests.slice(before).map((q) => q.url);
    expect(urls.some((u) => u.includes("/git/trees/"))).toBe(false);
  });

  it("re-saving identical bytes is not a change", async () => {
    const t = await synced({ "a.md": "A" });
    t.vault.set("a.md", "A"); // new mtime, same content
    expect((await t.sync()).status).toBe("nothing-to-do");
  });

  it("a rename is a delete plus an add in one commit", async () => {
    const t = await synced({ "characters/severus glass-staff.md": "boss" });
    t.vault.delete("characters/severus glass-staff.md");
    t.vault.set("characters/gary severus.md", "boss");
    const commits = t.gh.commits.size;
    await t.sync();
    expect(t.gh.commits.size).toBe(commits + 1);
    expect(t.gh.files()).toEqual({ "characters/gary severus.md": "boss" });
  });
});

describe("04 pull", () => {
  it("applies updates, adds and deletions (to trash) from GitHub", async () => {
    const t = await synced({ "voki.md": "old", "s011.md": "x", "keep.md": "k" });
    t.gh.commitFiles("main", { "voki.md": "new", "chars/wren stonehill.md": "W", "s011.md": null }, "Claude: story pass");
    const r = await t.sync();
    expect(t.vault.text("voki.md")).toBe("new");
    expect(t.vault.text("chars/wren stonehill.md")).toBe("W");
    expect(t.vault.trashed).toEqual(["s011.md"]);
    expect(r.remoteCommits).toEqual([{ message: "Claude: story pass", author: "Claude" }]);
  });

  it("downloads only changed blobs", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`n${i}.md`] = `v${i}`;
    const t = await synced(files);
    t.gh.commitFiles("main", { "n3.md": "changed", "n7.md": "changed" });
    const before = t.gh.requests.length;
    await t.sync();
    const blobGets = t.gh.requests.slice(before).filter((q) => q.method === "GET" && q.url.includes("/git/blobs/"));
    expect(blobGets).toHaveLength(2);
  });

  it("writes binary files byte for byte", async () => {
    const t = await synced({ "a.md": "A" });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 1]);
    t.gh.commitFiles("main", { "chibi.png": png as unknown as string });
    await t.sync();
    expect([...t.vault.files.get("chibi.png")!.bytes]).toEqual([...png]);
  });

  it("several commits since the last sync land as one update", async () => {
    const t = await synced({ "a.md": "1" });
    t.gh.commitFiles("main", { "a.md": "2" });
    t.gh.commitFiles("main", { "a.md": "3" });
    await t.sync();
    expect(t.vault.text("a.md")).toBe("3");
    expect(t.getState().baseCommit).toBe(t.gh.refs.get("main"));
  });
});

describe("05 push", () => {
  it("pushes edits, additions and deletions as one commit with a readable message", async () => {
    const t = await synced({ "timeline.md": "t", "old idea.md": "o" });
    t.vault.set("timeline.md", "t2");
    t.vault.set("wren stonehill.md", "w");
    t.vault.delete("old idea.md");
    const r = await t.sync();
    expect(r.pushed.sort()).toEqual(["old idea.md", "timeline.md", "wren stonehill.md"]);
    expect(t.gh.files()).toEqual({ "timeline.md": "t2", "wren stonehill.md": "w" });
    expect(t.gh.headMessage()).toBe(
      `BrandonGitsidian: 3 notes from ${DEVICE}\n\n- deleted: old idea.md\n- updated: timeline.md\n- added: wren stonehill.md`,
    );
    const patches = t.gh.requests.filter((q) => q.method === "PATCH");
    expect(patches.every((q) => JSON.parse(q.body!).force === false)).toBe(true);
  });

  it("no changes means no commit", async () => {
    const t = await synced({ "a.md": "A" });
    const commits = t.gh.commits.size;
    await t.sync();
    expect(t.gh.commits.size).toBe(commits);
  });

  it("if Claude pushes mid-sync, it pulls and rebuilds on top instead of forcing", async () => {
    const t = await synced({ "quests.md": "q", "other.md": "o" });
    t.vault.set("quests.md", "q2");
    t.gh.beforeRefUpdate = () => t.gh.commitFiles("main", { "other.md": "o2" });
    const r = await t.sync();
    expect(r.status).toBe("ok");
    expect(t.gh.files()).toEqual({ "quests.md": "q2", "other.md": "o2" });
    expect(t.vault.text("other.md")).toBe("o2");
    expect(formatLog(t.log.all())).toContain("GitHub changed while pushing");
  });

  it("uploads binary files and the blob SHA matches the local one", async () => {
    const t = await synced({ "a.md": "A" });
    t.vault.set("chibi.jpeg", new Uint8Array([255, 216, 255, 0, 1]));
    await t.sync();
    expect(formatLog(t.log.all())).not.toContain("SHA mismatch");
    expect(t.getState().index["chibi.jpeg"]).toBeDefined();
  });
});

describe("06 conflicts", () => {
  const base = "# timeline\n## s003\nfire\na\nb\nc\nd\n## s014\nnext\n";
  let t: Awaited<ReturnType<typeof synced>>;
  beforeEach(async () => {
    t = await synced({ "timeline.md": base, "players/suri.md": "s", "players/noxen.md": "n", "chibi.png": "img" });
  });

  it("merges edits to different parts and pushes the merge", async () => {
    t.vault.set("timeline.md", base.replace("next", "next\n- blade fight"));
    t.gh.commitFiles("main", { "timeline.md": base.replace("fire", "fire and rescue") });
    const r = await t.sync();
    expect(r.merged).toEqual(["timeline.md"]);
    expect(t.gh.files()["timeline.md"]).toContain("fire and rescue");
    expect(t.gh.files()["timeline.md"]).toContain("- blade fight");
    expect(t.vault.files.has(CONFLICT_LOG_PATH)).toBe(false);
  });

  it("same lines: GitHub wins, no copy, mine is in the conflict log, and the log is pushed", async () => {
    t.vault.set("timeline.md", base.replace("fire", "MINE"));
    t.gh.commitFiles("main", { "timeline.md": base.replace("fire", "THEIRS") });
    const r = await t.sync();
    expect(r.conflicts).toEqual(["timeline.md"]);
    expect(t.vault.text("timeline.md")).toContain("THEIRS");
    expect([...t.vault.files.keys()].filter((p) => p.includes("conflict 2"))).toEqual([]);
    const logNote = t.gh.files()[CONFLICT_LOG_PATH]!;
    expect(logNote).toContain("[[timeline]]");
    expect(logNote).toContain("> MINE");
  });

  it("binary conflict keeps GitHub's bytes and logs only the size", async () => {
    t.vault.set("chibi.png", "mine-bytes");
    t.gh.commitFiles("main", { "chibi.png": "their-bytes" });
    await t.sync();
    expect(t.vault.text("chibi.png")).toBe("their-bytes");
    expect(t.vault.text(CONFLICT_LOG_PATH)).toContain("discarded file size: 10 bytes");
  });

  it("edited here, deleted there: trashed and logged", async () => {
    t.vault.set("players/suri.md", "s2");
    t.gh.commitFiles("main", { "players/suri.md": null });
    await t.sync();
    expect(t.vault.trashed).toContain("players/suri.md");
    expect(t.gh.files()["players/suri.md"]).toBeUndefined();
    expect(t.vault.text(CONFLICT_LOG_PATH)).toContain("file deleted on GitHub");
  });

  it("deleted here, edited there: restored with GitHub's edits", async () => {
    t.vault.delete("players/noxen.md");
    t.gh.commitFiles("main", { "players/noxen.md": "n2" });
    await t.sync();
    expect(t.vault.text("players/noxen.md")).toBe("n2");
    expect(t.vault.text(CONFLICT_LOG_PATH)).toContain("deletion undone");
  });

  it("both created the same path: GitHub's wins", async () => {
    t.vault.set("notes/ideas.md", "X");
    t.gh.commitFiles("main", { "notes/ideas.md": "Y" });
    await t.sync();
    expect(t.vault.text("notes/ideas.md")).toBe("Y");
    expect(t.vault.text(CONFLICT_LOG_PATH)).toContain("> X");
  });
});

describe("07 push-only quick sync", () => {
  it("pushes local edits when GitHub hasn't moved", async () => {
    const t = await synced({ "a.md": "A" });
    t.vault.set("a.md", "A2");
    const r = await t.sync({ pushOnly: true });
    expect(r.pushed).toEqual(["a.md"]);
  });
  it("does nothing when GitHub has moved (needs a full sync)", async () => {
    const t = await synced({ "a.md": "A" });
    t.vault.set("a.md", "A2");
    t.gh.commitFiles("main", { "b.md": "B" });
    const r = await t.sync({ pushOnly: true });
    expect(r.status).toBe("skipped");
    expect(t.vault.files.has("b.md")).toBe(false);
  });
});

describe("08 safety", () => {
  it("never deletes a file sync has never seen", async () => {
    const t = await synced({ "a.md": "A" });
    t.vault.set("brand new.md", "N");
    await t.sync();
    expect(t.gh.files()["brand new.md"]).toBe("N");
  });

  it("asks before mass deletions and does nothing meanwhile", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`n${i}.md`] = `${i}`;
    const t = await synced(files);
    const del: Record<string, null> = {};
    for (let i = 0; i < 26; i++) del[`n${i}.md`] = null;
    t.gh.commitFiles("main", del);
    const r = await t.sync();
    expect(r.decision?.kind).toBe("mass-deletion");
    expect(t.vault.trashed).toEqual([]);
    const r2 = await t.sync({ confirmMassDeletion: true });
    expect(r2.trashed).toHaveLength(26);
  });

  it("a wiped vault doesn't wipe GitHub, and can be restored", async () => {
    const t = await synced({ "a.md": "A", "b.md": "B" });
    t.vault.files.clear();
    const r = await t.sync();
    expect(r.decision?.kind).toBe("vault-wiped");
    expect(Object.keys(t.gh.files())).toHaveLength(2);
    await t.sync({ restoreWipedVault: true });
    expect(t.vault.text("a.md")).toBe("A");
  });

  it("an interrupted pull keeps the old base and resumes cleanly", async () => {
    const t = await synced({ "a.md": "1", "b.md": "1" });
    const oldBase = t.getState().baseCommit;
    t.gh.commitFiles("main", { "a.md": "2", "b.md": "2" });
    t.vault.set("a.md", "2"); // landed before the interruption
    expect(t.getState().baseCommit).toBe(oldBase);
    const r = await t.sync();
    expect(r.pulled).toEqual(["b.md"]);
    expect(r.conflicts).toEqual([]);
  });

  it("preview changes nothing", async () => {
    const t = await synced({ "a.md": "A" });
    t.vault.set("a.md", "A2");
    t.gh.commitFiles("main", { "b.md": "B" });
    const commits = t.gh.commits.size;
    const r = await t.sync({ dryRun: true });
    expect(r.preview).toEqual([
      { path: "a.md", action: "push update" },
      { path: "b.md", action: "pull add" },
    ]);
    expect(t.gh.commits.size).toBe(commits);
    expect(t.vault.files.has("b.md")).toBe(false);
  });
});

describe("09 limits and errors", () => {
  it("skips files over the size limit on both sides", async () => {
    const t = setup({ maxFileBytes: 10 });
    t.gh.commitFiles("main", { "small.md": "s", "big-remote.png": "x".repeat(50) });
    t.vault.set("big-local.png", "y".repeat(50));
    const r = await t.sync({ firstSyncChoice: "merge" });
    expect(r.skipped.map((s) => s.path).sort()).toEqual(["big-local.png", "big-remote.png"]);
    expect(t.vault.files.has("big-remote.png")).toBe(false);
    expect(t.gh.files()["big-local.png"]).toBeUndefined();
  });

  it("skips remote paths iOS can't store", async () => {
    const t = setup();
    t.gh.commitFiles("main", { "ok.md": "1", "bad:name.md": "2" });
    const r = await t.sync();
    expect(r.skipped).toEqual([{ path: "bad:name.md", reason: "name isn't valid on iOS" }]);
  });

  it("an invalid token stops the sync with a helpful message and no changes", async () => {
    const t = await synced({ "a.md": "A" });
    t.gh.token = "rotated";
    t.vault.set("a.md", "A2");
    const r = await t.sync();
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain("token");
    expect(t.gh.files()["a.md"]).toBe("A");
  });

  it("a rewritten history needs a decision", async () => {
    const t = await synced({ "a.md": "A" });
    t.gh.refs.clear();
    t.gh.commitFiles("main", { "a.md": "fresh start" });
    const r = await t.sync();
    expect(r.decision?.kind).toBe("history-rewritten");
  });

  it("a missing branch is reported", async () => {
    const t = await synced({ "a.md": "A" });
    t.gh.refs.set("dev", t.gh.refs.get("main")!);
    t.gh.refs.delete("main");
    const r = await t.sync();
    expect(r.decision?.kind).toBe("branch-missing");
  });

  it("network failures stop without moving the base", async () => {
    const t = await synced({ "a.md": "A" });
    const base = t.getState().baseCommit;
    t.gh.offline = true;
    const r = await t.sync();
    expect(r.error?.kind).toBe("network");
    expect(t.getState().baseCommit).toBe(base);
  });
});

describe("13 detailed log during sync", () => {
  it("numbers runs and tells the story", async () => {
    const t = await synced({ "a.md": "A" });
    t.vault.set("a.md", "A2");
    await t.sync();
    const run2 = t.log.list({ run: 2 }).map((e) => e.msg);
    expect(run2[0]).toMatch(/^Sync #2 started/);
    expect(run2.at(-1)).toMatch(/^Sync finished: ok.*pushed 1.*took \d+ ms/);
    expect(run2.some((m) => m.startsWith("Classified a.md: push update"))).toBe(true);
    expect(run2.some((m) => /^HTTP PATCH .* -> 200/.test(m))).toBe(true);
  });

  it("never logs note contents", async () => {
    const t = await synced({ "a.md": "SECRET-CONTENT-123" });
    expect(formatLog(t.log.all())).not.toContain("SECRET-CONTENT-123");
  });
});

describe("08 big pushes are batched and resumable", () => {
  it("splits a large push into commits of 40 and saves progress after each", async () => {
    const t = await synced({ "seed.md": "s" });
    for (let i = 0; i < 90; i++) t.vault.set(`n/${i}.md`, `v${i}`);
    const commits = t.gh.commits.size;
    const saves = t.saves.length;
    const r = await t.sync();
    expect(r.pushed).toHaveLength(90);
    expect(t.gh.commits.size - commits).toBe(3);
    expect(t.gh.headMessage()).toMatch(/\(part 3 of 3\)/);
    expect(t.saves.length - saves).toBeGreaterThanOrEqual(3);
    expect(Object.keys(t.gh.files())).toHaveLength(91);
  });

  it("an upload interrupted between batches resumes without losing or duplicating work", async () => {
    const t = await synced({ "seed.md": "s", "keep.md": "k" });
    for (let i = 0; i < 50; i++) t.vault.set(`n/${i}.md`, `v${i}`);
    t.vault.set("keep.md", "k2"); // an update to an existing file

    // Simulate iOS suspending the app right after the first batch's commit lands.
    const client = t.client as unknown as { o: { http: Http } };
    const realHttp = client.o.http;
    let committedOnce = false;
    client.o.http = async (req) => {
      if (committedOnce) throw new Error("suspended");
      const res = await realHttp(req);
      if (req.method === "PATCH") committedOnce = true;
      return res;
    };
    const r1 = await t.sync();
    expect(r1.status).toBe("error");
    const partial = Object.keys(t.gh.files()).length;
    expect(partial).toBeGreaterThan(2);
    expect(partial).toBeLessThan(52);

    client.o.http = realHttp;
    const r2 = await t.sync();
    expect(r2.status).toBe("ok");
    expect(r2.conflicts).toEqual([]);
    expect(Object.keys(t.gh.files())).toHaveLength(52);
    expect(t.gh.files()["keep.md"]).toBe("k2");
  });
});

describe("13 the log reads like a story", () => {
  it("announces each step, the plan and per-file progress", async () => {
    const t = await synced({ "voki.md": "old", "a.md": "a" });
    t.gh.commitFiles("main", { "voki.md": "new" });
    t.vault.set("a.md", "a2");
    await t.sync();
    const story = t.log.list({ run: 2, level: "info" }).map((e) => e.msg);
    expect(story).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Step 1\/5: checking GitHub branch "main"/),
        expect.stringMatching(/^Step 2\/5: scanning the vault/),
        expect.stringMatching(/^Vault: 2 tracked files; 1 read and hashed, 1 unchanged since last sync/),
        expect.stringMatching(/^GitHub: 2 files at [0-9a-f]{7}/),
        "Step 4/5: planning — 1 to pull, 1 to push, 0 to delete, 0 changed on both sides, 0 unchanged",
        expect.stringMatching(/^Pulling 1\/1: voki.md \(updated, 3 B\)/),
        expect.stringMatching(/^Uploading 1\/1: a.md \(updated, 2 B\)/),
        expect.stringMatching(/^Committed as [0-9a-f]{7}: BrandonGitsidian: 1 note from/),
      ]),
    );
  });
});
