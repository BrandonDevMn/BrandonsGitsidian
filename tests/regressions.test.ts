import { describe, expect, it } from "vitest";
import { SyncEngine, type SyncState, type SyncOptions } from "../src/sync/engine";
import { GitHubClient, type Http } from "../src/github/client";
import { Logger } from "../src/core/logger";
import { DEFAULT_EXCLUDES } from "../src/core/paths";
import { FakeGitHub } from "./fakeGitHub";
import { MemVault } from "./memVault";

/**
 * Bugs found in Brandon's detailed log, reproduced as tests first (TDD).
 * Bug notes: Claudian/code/brandon-gitsidian/bugs/
 */

function setup() {
  const gh = new FakeGitHub();
  const vault = new MemVault();
  const log = new Logger();
  let state: SyncState = { repoKey: "BrandonDevMn/Claudian@main", baseCommit: null, index: {} };
  const client = new GitHubClient({ owner: "BrandonDevMn", repo: "Claudian", token: "good-token", http: gh.http, log, sleep: async () => {}, writeGapMs: 0 });
  const engine = new SyncEngine(
    vault,
    client,
    { branch: "main", excludes: DEFAULT_EXCLUDES, maxFileBytes: 20 * 1024 * 1024, device: "Brandon's iPhone", now: () => new Date(2026, 10, 21, 11, 6) },
    log,
    () => state,
    async (s) => {
      state = s;
    },
  );
  const sync = (o: Partial<SyncOptions> = {}) => engine.sync({ trigger: "test", ...o });
  const http = client as unknown as { o: { http: Http } };
  return { gh, vault, log, sync, http, getState: () => state };
}

describe("bug: false conflicts on files the phone didn't edit (log runs #11-#12, 261121)", () => {
  it("a file pulled by a sync whose push then failed is not a conflict next time", async () => {
    const t = setup();
    t.gh.commitFiles("main", { "_ai-context/file-rules.md": "v1", "conflict log.md": "c1" });
    expect((await t.sync()).status).toBe("ok");

    // Claude edits file-rules on GitHub; the phone has its own change to push.
    t.gh.commitFiles("main", { "_ai-context/file-rules.md": "v2" });
    t.vault.set("conflict log.md", "c2");

    // Like #11: the pull lands, then every push attempt hits "not a fast forward"
    // because Claude keeps committing.
    const real = t.http.o.http;
    t.http.o.http = async (req) => {
      const res = await real(req);
      if (req.method === "POST" && req.url.endsWith("/git/commits")) t.gh.commitFiles("main", { "elsewhere.md": String(Math.random()) });
      return res;
    };
    const r1 = await t.sync();
    expect(r1.status).toBe("error");
    expect(t.vault.text("_ai-context/file-rules.md")).toBe("v2"); // the pull happened

    // Like #12: Claude edits file-rules again, then the phone syncs normally.
    t.http.o.http = real;
    t.gh.commitFiles("main", { "_ai-context/file-rules.md": "v3" });
    const r2 = await t.sync();
    expect(r2.conflicts).toEqual([]);
    expect(t.vault.text("_ai-context/file-rules.md")).toBe("v3");
    expect(t.gh.files()["conflict log.md"]).toBe("c2"); // the phone's own change still went up
  });
});

describe("bug: phone sync deleted two scene notes (commit 3f6a3e6, 261121)", () => {
  it("a note that goes missing without being deleted in Obsidian is restored, not deleted on GitHub", async () => {
    const t = setup();
    t.gh.commitFiles("main", { "scenes/marcus contract.md": "pact", "scenes/burning.md": "fire", "keep.md": "k" });
    await t.sync();
    t.vault.delete("scenes/marcus contract.md"); // vanished; Brandon never deleted it
    t.vault.delete("scenes/burning.md");
    const r = await t.sync();
    expect(t.gh.files()["scenes/marcus contract.md"]).toBe("pact");
    expect(t.gh.files()["scenes/burning.md"]).toBe("fire");
    expect(t.vault.text("scenes/marcus contract.md")).toBe("pact");
    expect(r.pushed).toEqual([]);
  });

  it("a note Brandon deleted in Obsidian is deleted on GitHub", async () => {
    const t = setup();
    t.gh.commitFiles("main", { "old.md": "o", "keep.md": "k" });
    await t.sync();
    t.vault.delete("old.md");
    await t.sync({ userDeleted: ["old.md"] });
    expect(t.gh.files()["old.md"]).toBeUndefined();
    expect(t.gh.files()["keep.md"]).toBe("k");
  });
});
