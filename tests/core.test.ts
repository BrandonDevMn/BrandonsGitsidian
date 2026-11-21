import { describe, expect, it } from "vitest";
import { gitBlobSha, utf8, bytesToBase64, base64ToBytes, isTextPath } from "../src/core/blob";
import { classifyPath } from "../src/core/classify";
import { isExcluded, DEFAULT_EXCLUDES, isValidOnIos } from "../src/core/paths";
import { mergeText } from "../src/core/merge";
import { addEntries, MAX_ENTRIES } from "../src/core/conflictLog";
import { commitMessage } from "../src/core/commitMessage";
import { isMassDeletion, vaultLooksWiped } from "../src/core/safety";
import { Logger, redact, formatLog } from "../src/core/logger";

describe("blob SHA (03 Blob SHAs are computed the same way git does)", () => {
  it("matches git hash-object for 'hello\\n'", async () => {
    expect(await gitBlobSha(utf8.encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
  it("matches git for an empty file", async () => {
    expect(await gitBlobSha(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
  it("round-trips base64 for binary", () => {
    const bytes = new Uint8Array([0, 255, 10, 13, 128]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
  it("knows text from binary", () => {
    expect(isTextPath("a/b.md")).toBe(true);
    expect(isTextPath("x.jpeg")).toBe(false);
  });
});

describe("classification table (03 Classify each path)", () => {
  const U = undefined;
  const rows: [string, string | undefined, string | undefined, string | undefined, string][] = [
    ["quests.md", "A", "A", "A", "unchanged"],
    ["timeline.md", "A", "A2", "A", "push update"],
    ["voki.md", "A", "A", "A2", "pull update"],
    ["wren.md", U, "N", U, "push add"],
    ["weeping hollow.md", U, U, "N", "pull add"],
    ["old.md", "A", U, "A", "push delete"],
    ["ooo s014.md", "A", "A", U, "pull delete"],
    ["esa.md", "A", "A2", "A3", "conflict"],
    ["kuy.md", "A", "A2", "A2", "same"],
    ["draft.md", U, "X", "Y", "conflict"],
    ["same.md", U, "X", "X", "same"],
    ["suri.md", "A", "A2", U, "conflict"],
    ["noxen.md", "A", U, "A2", "conflict"],
    ["syfer.md", "A", U, U, "same"],
  ];
  for (const [path, base, local, remote, expected] of rows) {
    it(path, () => {
      const a = classifyPath(base, local, remote);
      const got = a.kind === "push" || a.kind === "pull" ? `${a.kind} ${a.change}` : a.kind;
      expect(got).toBe(expected);
    });
  }
});

describe("exclusions (01 Default exclusions)", () => {
  it("excludes defaults", () => {
    expect(isExcluded(".obsidian/app.json", DEFAULT_EXCLUDES)).toBe(true);
    expect(isExcluded(".trash/x.md", DEFAULT_EXCLUDES)).toBe(true);
    expect(isExcluded("_ai-context/file-rules.md", DEFAULT_EXCLUDES)).toBe(false);
  });
  it("supports *.ext and dir/**", () => {
    expect(isExcluded("a/b/c.tmp", ["*.tmp"])).toBe(true);
    expect(isExcluded("private/deep/x.md", ["private/**"])).toBe(true);
    expect(isExcluded("public/x.md", ["private/**"])).toBe(false);
  });
  it("flags iOS-invalid paths", () => {
    expect(isValidOnIos("notes/a:b.md")).toBe(false);
    expect(isValidOnIos("games/overseers-of-oakhaven/characters/gary severus.md")).toBe(true);
  });
});

describe("three-way merge (06)", () => {
  const base = ["# timeline", "## ooo s003", "fire", "x", "y", "z", "## ooo s014", "next"].join("\n");
  it("merges edits in different sections", () => {
    const mine = base.replace("next", "next\n- blade fight");
    const theirs = base.replace("fire", "fire and rescue");
    const r = mergeText(base, mine, theirs);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("fire and rescue");
      expect(r.text).toContain("- blade fight");
    }
  });
  it("reports a conflict when the same line changes differently", () => {
    expect(mergeText(base, base.replace("fire", "A"), base.replace("fire", "B")).ok).toBe(false);
  });
  it("accepts identical edits on both sides", () => {
    const both = base.replace("fire", "same");
    expect(mergeText(base, both, both)).toEqual({ ok: true, text: both });
  });
});

describe("conflict log (06)", () => {
  const entry = (i: number) => ({
    when: new Date(2026, 10, 21, 14, i),
    device: "Brandon's iPhone",
    path: `notes/n${i}.md`,
    what: "edit discarded" as const,
    discardedText: `text ${i}`,
  });
  it("puts newest first with the discarded text in a collapsed callout", () => {
    const doc = addEntries(null, [entry(1), entry(5)]);
    expect(doc.indexOf("14:05")).toBeLessThan(doc.indexOf("14:01"));
    expect(doc).toContain("> [!note]- My discarded version");
    expect(doc).toContain("> text 5");
  });
  it("keeps only the newest 100 entries", () => {
    let doc: string | null = null;
    for (let i = 0; i < 120; i++) doc = addEntries(doc, [{ ...entry(0), when: new Date(2026, 0, 1, 0, 0, i), path: `p${i}.md` }]);
    expect((doc as string).match(/^## /gm)?.length).toBe(MAX_ENTRIES);
    expect(doc).toContain("[[p119]]");
    expect(doc).not.toContain("[[p0]]");
  });
});

describe("commit message (05)", () => {
  it("summarises and lists changes", () => {
    const msg = commitMessage(
      [
        { path: "b.md", change: "update" },
        { path: "a.md", change: "add" },
        { path: "c.md", change: "update" },
      ],
      "Brandon's iPhone",
    );
    expect(msg.split("\n")[0]).toBe("BrandonGitsidian: 3 notes from Brandon's iPhone");
    expect(msg).toContain("- added: a.md\n- updated: b.md");
  });
});

describe("safety (08)", () => {
  it("flags mass deletions", () => {
    expect(isMassDeletion(25, 1000)).toBe(true);
    expect(isMassDeletion(19, 185)).toBe(true);
    expect(isMassDeletion(3, 185)).toBe(false);
    expect(isMassDeletion(1, 3)).toBe(false); // tiny vaults aren't nagged
    expect(isMassDeletion(5, 20)).toBe(true);
  });
  it("detects a wiped vault", () => {
    expect(vaultLooksWiped(185, 0)).toBe(true);
    expect(vaultLooksWiped(0, 0)).toBe(false);
  });
});

describe("detailed log (10)", () => {
  it("never stores tokens", () => {
    expect(redact("Authorization: Bearer github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ")).not.toContain("github_pat_");
    expect(redact("token ghp_abcdefghijklmnopqrstuvwxyz123456")).toContain("[redacted]");
  });
  it("keeps newest 2000 and filters by level", () => {
    const log = new Logger();
    for (let i = 0; i < 2100; i++) log.debug(`d${i}`);
    log.error("boom");
    expect(log.all().length).toBe(2000);
    expect(log.list("error").map((e) => e.msg)).toEqual(["boom"]);
    expect(log.list()[0]?.msg).toBe("boom");
  });
  it("searches, filters by run, honours the debug switch and records clears", () => {
    let t = 0;
    const log = new Logger([], () => ++t);
    log.info("before");
    const run = log.startRun();
    log.info("timeline.md pulled");
    log.debug("HTTP GET x");
    log.endRun();
    log.debugEnabled = false;
    log.debug("hidden");
    expect(log.list({ search: "TIMELINE" }).map((e) => e.msg)).toEqual(["timeline.md pulled"]);
    expect(log.list({ run }).map((e) => e.msg)).toEqual(["timeline.md pulled", "HTTP GET x"]);
    expect(log.all().some((e) => e.msg === "hidden")).toBe(false);
    expect(formatLog(log.list({ run }), "header")).toMatch(/^header\n\n.* INFO  #1 timeline.md pulled/);
    let changes = 0;
    const off = log.onChange(() => changes++);
    log.clear();
    off();
    expect(log.all().map((e) => e.msg)).toEqual(["Log cleared"]);
    expect(changes).toBe(1);
  });
});

describe("01 settings: only the repo and token are chosen", () => {
  it("ignores old saved values for everything except owner, repo, branch, token and pause", async () => {
    const { loadSettings, DEFAULT_SETTINGS } = await import("../src/core/settings");
    const s = loadSettings({ owner: "BrandonDevMn", repo: "Claudian", branch: "main", tokenSecretId: "gh", paused: true, intervalMinutes: 99, excludes: ["x/"], deviceName: "Old", logDebug: false });
    expect(s).toMatchObject({ owner: "BrandonDevMn", repo: "Claudian", branch: "main", tokenSecretId: "gh", paused: true });
    expect(s.intervalMinutes).toBe(DEFAULT_SETTINGS.intervalMinutes);
    expect(s.excludes).toEqual([".obsidian/", ".trash/", ".git/"]);
    expect(s.deviceName).toBe("Brandon's iPhone");
    expect(s.logDebug).toBe(true);
    expect(loadSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
});
