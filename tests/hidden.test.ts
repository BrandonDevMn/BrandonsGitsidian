import { describe, expect, it, vi } from "vitest";
import { findHiddenFiles, isHiddenPath, type Listing } from "../src/core/hidden";
import { HiddenFileIO, type PublicAdapter } from "../src/core/hiddenIO";
import { HiddenFileRevealer, missingInternals, UNSUPPORTED_MESSAGE, type AdapterInternals, type StatLike } from "../src/core/revealer";
import { isExcluded, DEFAULT_EXCLUDES } from "../src/core/paths";

const skipExcluded = (p: string) => isExcluded(p, DEFAULT_EXCLUDES);

/** A tiny on-disk tree: folders are implied by file paths. */
class Disk {
  files = new Map<string, Uint8Array>();
  folders = new Set<string>([""]);
  constructor(paths: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(paths)) this.put(p, c);
  }
  put(path: string, content: string | Uint8Array): void {
    this.files.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
  }
  has(path: string): boolean {
    return this.files.has(path) || this.folders.has(path);
  }
  list(path: string): Listing {
    if (!this.folders.has(path)) throw new Error(`no folder ${path}`);
    const direct = (p: string) => (path === "" ? !p.includes("/") : p.startsWith(path + "/") && !p.slice(path.length + 1).includes("/"));
    return {
      files: [...this.files.keys()].filter((p) => direct(p)),
      folders: [...this.folders].filter((p) => p !== "" && direct(p)),
    };
  }
}

describe("files/02 which paths are hidden", () => {
  it.each([".gitignore", ".github/workflows/release.yml", "code/scripts/.env.example", ".obsidian/app.json", "games/overseers-of-oakhaven/.notes"])(
    "%s is hidden",
    (p) => expect(isHiddenPath(p)).toBe(true),
  );
  it.each(["games/overseers-of-oakhaven/timeline.md", "a.b.md", "code/x.py"])("%s is not hidden", (p) => expect(isHiddenPath(p)).toBe(false));
  it("treats . and .. as path parts, not dot files", () => {
    expect(isHiddenPath("./a.md")).toBe(false);
    expect(isHiddenPath("../a.md")).toBe(false);
  });
});

describe("sync/01 finding dot files Obsidian doesn't index", () => {
  const disk = new Disk({
    "a.md": "A",
    ".gitignore": "x",
    ".github/workflows/release.yml": "y",
    "code/scripts/.env.example": "z",
    "code/scripts/run.py": "p",
    "games/x/.notes/deep/n.txt": "n",
    ".obsidian/app.json": "{}",
    ".git/objects/ab/cdef": "obj",
    ".trash/old.md": "o",
  });
  const lister = async (p: string) => disk.list(p);

  it("finds dot files at any depth, including inside dot folders, and only dot files", async () => {
    const found = await findHiddenFiles(lister, ["", "code", "code/scripts", "games", "games/x"], skipExcluded);
    expect(found).toEqual([".github/workflows/release.yml", ".gitignore", "code/scripts/.env.example", "games/x/.notes/deep/n.txt"]);
  });

  it("never walks .obsidian, .git or .trash", async () => {
    const calls: string[] = [];
    await findHiddenFiles(async (p) => (calls.push(p), disk.list(p)), [""], skipExcluded);
    const inside = (c: string, d: string) => c === d || c.startsWith(`${d}/`);
    expect(calls.some((c) => inside(c, ".git") || inside(c, ".obsidian") || inside(c, ".trash"))).toBe(false);
    expect(calls).toContain(".github"); // a dot folder that merely starts with ".git" is still walked
  });

  it("lists every folder once and survives folders that vanish mid-walk", async () => {
    const calls: string[] = [];
    const found = await findHiddenFiles(
      async (p) => {
        calls.push(p);
        if (p === "gone") throw new Error("vanished");
        return disk.list(p);
      },
      ["", "", "gone"],
      skipExcluded,
    );
    expect(calls.filter((c) => c === "").length).toBe(1);
    expect(found).toContain(".gitignore");
  });

  it("strips leading slashes some adapters return", async () => {
    const found = await findHiddenFiles(async () => ({ files: ["/.gitignore"], folders: [] }), [""], skipExcluded);
    expect(found).toEqual([".gitignore"]);
  });
});

function memAdapter(disk: Disk, opts: { systemTrash?: boolean } = {}) {
  const trashed: string[] = [];
  const a: PublicAdapter = {
    list: async (p) => disk.list(p),
    stat: async (p) =>
      disk.files.has(p) ? { size: disk.files.get(p)!.byteLength, mtime: 42, type: "file" } : disk.folders.has(p) ? { size: 0, mtime: 0, type: "folder" } : null,
    exists: async (p) => disk.has(p),
    readBinary: async (p) => {
      const b = disk.files.get(p)!;
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    writeBinary: async (p, data) => disk.put(p, new Uint8Array(data)),
    mkdir: vi.fn(async (p: string) => void disk.folders.add(p)),
    trashSystem: async (p) => {
      if (!opts.systemTrash) return false;
      trashed.push(`system:${p}`);
      disk.files.delete(p);
      return true;
    },
    trashLocal: async (p) => {
      trashed.push(`local:${p}`);
      disk.files.delete(p);
    },
  };
  return { a, trashed };
}

describe("sync/01 reading and writing dot files", () => {
  it("lists dot files with their size and mtime, skipping folders and excluded paths", async () => {
    const disk = new Disk({ ".gitignore": "abc", ".obsidian/app.json": "{}", "a.md": "A" });
    const io = new HiddenFileIO(memAdapter(disk).a, skipExcluded);
    expect(await io.list([""])).toEqual([{ path: ".gitignore", size: 3, mtime: 42 }]);
  });

  it("drops paths that aren't files by the time they're stat'ed", async () => {
    const disk = new Disk({ ".gitignore": "abc" });
    const { a } = memAdapter(disk);
    const io = new HiddenFileIO({ ...a, stat: async () => null }, skipExcluded);
    expect(await io.list([""])).toEqual([]);
  });

  it("reads bytes back exactly", async () => {
    const disk = new Disk({ ".env": "TOKEN=1" });
    const io = new HiddenFileIO(memAdapter(disk).a, skipExcluded);
    expect(new TextDecoder().decode(await io.read(".env"))).toBe("TOKEN=1");
  });

  it("writes a dot file, creating missing folders, then shows it in the explorer", async () => {
    const disk = new Disk();
    const { a } = memAdapter(disk);
    const shown: string[] = [];
    const io = new HiddenFileIO(a, skipExcluded, async (p) => void shown.push(p));
    const bytes = new TextEncoder().encode("on: push");
    const st = await io.write(".github/workflows/release.yml", bytes.subarray(0));
    expect(new TextDecoder().decode(disk.files.get(".github/workflows/release.yml"))).toBe("on: push");
    expect(a.mkdir).toHaveBeenCalledWith(".github");
    expect(a.mkdir).toHaveBeenCalledWith(".github/workflows");
    expect(shown).toEqual([".github/workflows/release.yml"]);
    expect(st).toEqual({ path: ".github/workflows/release.yml", size: 8, mtime: 42 });
  });

  it("writes only the bytes of a sliced buffer", async () => {
    const disk = new Disk();
    const io = new HiddenFileIO(memAdapter(disk).a, skipExcluded);
    const big = new TextEncoder().encode("xxHELLOxx");
    await io.write(".hello", big.subarray(2, 7));
    expect(new TextDecoder().decode(disk.files.get(".hello"))).toBe("HELLO");
  });

  it("falls back to the written size if stat fails", async () => {
    const disk = new Disk();
    const { a } = memAdapter(disk);
    const io = new HiddenFileIO({ ...a, stat: async () => null }, skipExcluded);
    const st = await io.write(".x", new Uint8Array([1, 2, 3]));
    expect(st.size).toBe(3);
  });

  it("trashes to the system trash when there is one", async () => {
    const disk = new Disk({ ".gitignore": "x" });
    const { a, trashed } = memAdapter(disk, { systemTrash: true });
    await new HiddenFileIO(a, skipExcluded).trash(".gitignore");
    expect(trashed).toEqual(["system:.gitignore"]);
  });

  it("falls back to Obsidian's .trash folder on iOS", async () => {
    const disk = new Disk({ ".gitignore": "x" });
    const { a, trashed } = memAdapter(disk);
    await new HiddenFileIO(a, skipExcluded).trash(".gitignore");
    expect(trashed).toEqual(["local:.gitignore"]);
  });

  it("does nothing when trashing a file that's already gone", async () => {
    const { a, trashed } = memAdapter(new Disk());
    await new HiddenFileIO(a, skipExcluded).trash(".gone");
    expect(trashed).toEqual([]);
  });
});

/** Fake Obsidian adapter internals. `index` is what Obsidian's file explorer would show. */
function fakeInternals(disk: Disk, kind: "desktop" | "mobile") {
  const index = new Set<string>();
  const deletedEvents: string[] = [];
  const a: AdapterInternals = {
    getFullPath: (p) => `/vault/${p}`,
    getRealPath: (p) => p,
    getFullRealPath: (p) => `/vault/${p}`,
    _exists: async (full) => disk.has(full.replace("/vault/", "")),
    // Obsidian's own behaviour: drop the path from the index.
    reconcileDeletion: async (_real, p) => {
      if (index.delete(p)) deletedEvents.push(p);
    },
    // Obsidian walks everything and, finding dot paths, calls reconcileDeletion for them.
    listRecursive: async () => {
      const all = [...disk.folders].filter((f) => f !== "").concat([...disk.files.keys()]);
      for (const p of all.sort()) {
        if (isHiddenPath(p)) await a.reconcileDeletion!(p, p);
        else index.add(p);
      }
    },
  };
  if (kind === "desktop") {
    a.reconcileFileInternal = async (_real, p) => void index.add(p);
  } else {
    a.fs = { stat: async (full): Promise<StatLike> => ({ type: disk.folders.has(full.replace("/vault/", "")) ? "directory" : "file" }) };
    a.reconcileFolderCreation = async (_real, p) => void index.add(p);
    a.reconcileFileChanged = (_real, p) => void index.add(p);
  }
  return { a, index, deletedEvents };
}

const quietLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() });

describe.each(["desktop", "mobile"] as const)("files/02 showing hidden files (%s)", (kind) => {
  const tree = () => new Disk({ "a.md": "A", ".gitignore": "x", ".github/workflows/release.yml": "y", ".obsidian/app.json": "{}", ".git/HEAD": "ref", ".trash/old.md": "o" });

  it("shows every dot file and folder, including .obsidian, .git and .trash", async () => {
    const disk = tree();
    const { a, index } = fakeInternals(disk, kind);
    const r = new HiddenFileRevealer(a, quietLog());
    expect(r.enable()).toBe(true);
    await r.scan();
    const shown = [...index];
    for (const p of [".gitignore", ".github", ".github/workflows", ".github/workflows/release.yml", ".obsidian", ".obsidian/app.json", ".git/HEAD", ".trash/old.md"]) {
      expect(shown).toContain(p);
    }
    expect(r.shown()).toContain(".git/HEAD");
    expect(r.scanning).toBe(false);
  });

  it("marks itself as scanning while it shows files in bulk", async () => {
    const disk = tree();
    const { a } = fakeInternals(disk, kind);
    const r = new HiddenFileRevealer(a, quietLog());
    r.enable();
    let during = false;
    const list = a.listRecursive!;
    a.listRecursive = async (p) => {
      during = r.scanning;
      await list(p);
    };
    await r.scan();
    expect(during).toBe(true);
    expect(r.scanning).toBe(false);
  });

  it("lets Obsidian really remove dot paths that no longer exist on disk", async () => {
    const disk = tree();
    const { a, index } = fakeInternals(disk, kind);
    const r = new HiddenFileRevealer(a, quietLog());
    r.enable();
    await r.scan();
    disk.files.delete(".gitignore");
    await a.reconcileDeletion!(".gitignore", ".gitignore");
    expect(index.has(".gitignore")).toBe(false);
    expect(r.shown()).not.toContain(".gitignore");
  });

  it("leaves normal deletions alone", async () => {
    const disk = tree();
    const { a, index } = fakeInternals(disk, kind);
    const r = new HiddenFileRevealer(a, quietLog());
    r.enable();
    await r.scan();
    await a.reconcileDeletion!("a.md", "a.md");
    expect(index.has("a.md")).toBe(false);
  });

  it("shows a dot file sync just wrote, with its dot parent folders", async () => {
    const disk = tree();
    const { a, index } = fakeInternals(disk, kind);
    const r = new HiddenFileRevealer(a, quietLog());
    r.enable();
    disk.put(".claude/notes/n.md", "n");
    await r.reveal(".claude/notes/n.md");
    const shown = [...index];
    expect(shown).toEqual(expect.arrayContaining([".claude", ".claude/notes", ".claude/notes/n.md"]));
  });

  it("turning it off hides them again, deepest first, flagged as hiding so it isn't a deletion", async () => {
    const disk = tree();
    const { a, index, deletedEvents } = fakeInternals(disk, kind);
    const r = new HiddenFileRevealer(a, quietLog());
    const original = a.reconcileDeletion;
    r.enable();
    await r.scan();
    let flaggedThroughout = true;
    const orig = original!;
    // Watch the flag on every hide call.
    (r as unknown as { original: typeof orig }).original = async (real: string, p: string) => {
      if (!r.hiding) flaggedThroughout = false;
      await orig(real, p);
    };
    await r.disable();
    expect(flaggedThroughout).toBe(true);
    expect(r.hiding).toBe(false);
    expect([...index].filter((p) => isHiddenPath(p))).toEqual([]);
    expect(deletedEvents.indexOf(".github/workflows/release.yml")).toBeLessThan(deletedEvents.indexOf(".github"));
    expect(disk.files.has(".gitignore")).toBe(true); // nothing on disk changed
    expect(r.active).toBe(false);
    expect(r.shown()).toEqual([]);
  });
});

describe("files/02 failing quietly", () => {
  it("names what's missing and stays off when Obsidian's internals changed", () => {
    const log = quietLog();
    const r = new HiddenFileRevealer({}, log);
    expect(r.enable()).toBe(false);
    expect(r.active).toBe(false);
    expect(log.warn.mock.calls[0]![0]).toContain(UNSUPPORTED_MESSAGE);
    expect(missingInternals({})).toEqual(["reconcileDeletion", "_exists", "getFullPath", "getRealPath", "listRecursive", "reconcileFileInternal or reconcileFileChanged"]);
  });

  it("needs all of the mobile internals when there's no desktop one", () => {
    const { a } = fakeInternals(new Disk(), "mobile");
    expect(missingInternals(a)).toEqual([]);
    expect(missingInternals({ ...a, fs: {} })).toEqual(["reconcileFileInternal or reconcileFileChanged"]);
  });

  it("scan, reveal and disable do nothing when it's off", async () => {
    const r = new HiddenFileRevealer({}, quietLog());
    await r.scan();
    await r.reveal(".gitignore");
    await r.disable();
    expect(r.shown()).toEqual([]);
  });

  it("enabling twice wraps only once", () => {
    const { a } = fakeInternals(new Disk(), "desktop");
    const r = new HiddenFileRevealer(a, quietLog());
    r.enable();
    const wrapped = a.reconcileDeletion;
    expect(r.enable()).toBe(true);
    expect(a.reconcileDeletion).toBe(wrapped);
  });

  it("reveal ignores paths that aren't hidden", async () => {
    const { a, index } = fakeInternals(new Disk({ "a.md": "A" }), "desktop");
    const r = new HiddenFileRevealer(a, quietLog());
    r.enable();
    await r.reveal("a.md");
    expect(index.size).toBe(0);
  });

  it("if checking a dot path fails, Obsidian's normal behaviour runs", async () => {
    const disk = new Disk({ ".gitignore": "x" });
    const { a, index } = fakeInternals(disk, "desktop");
    index.add(".gitignore");
    a._exists = async () => {
      throw new Error("boom");
    };
    const log = quietLog();
    new HiddenFileRevealer(a, log).enable();
    await a.reconcileDeletion!(".gitignore", ".gitignore");
    expect(index.has(".gitignore")).toBe(false);
    expect(log.debug).toHaveBeenCalled();
  });

  it("a failed rescan is logged, not thrown", async () => {
    const { a } = fakeInternals(new Disk(), "desktop");
    a.listRecursive = async () => {
      throw new Error("nope");
    };
    const log = quietLog();
    const r = new HiddenFileRevealer(a, log);
    r.enable();
    await r.scan();
    expect(log.warn).toHaveBeenCalledWith("Hidden files: rescan failed: nope");
    expect(r.scanning).toBe(false);
  });

  it("a path that can't be shown or hidden is logged and skipped", async () => {
    const disk = new Disk({ ".gitignore": "x" });
    const { a } = fakeInternals(disk, "desktop");
    a.reconcileFileInternal = async () => {
      throw new Error("no");
    };
    const log = quietLog();
    const r = new HiddenFileRevealer(a, log);
    r.enable();
    await r.reveal(".gitignore");
    const orig = (r as unknown as { original: (x: string, y: string) => Promise<void> }).original;
    (r as unknown as { original: typeof orig }).original = async () => {
      throw new Error("stuck");
    };
    await r.disable();
    expect(log.debug.mock.calls.map((c) => c[0])).toEqual(["Couldn't show .gitignore: no", "Couldn't hide .gitignore again: stuck"]);
  });
});

describe('files/02 "Detect all file extensions" while showing hidden files', () => {
  const cfg = (initial: unknown, opts: { throwOnSet?: boolean } = {}) => {
    const store: Record<string, unknown> = { showUnsupportedFiles: initial };
    return {
      store,
      config: {
        get: (k: string) => store[k],
        set: (k: string, v: unknown) => {
          if (opts.throwOnSet) throw new Error("read-only");
          store[k] = v;
        },
      },
    };
  };

  it.each([false, undefined])("turns it on while running and back off afterwards (was %s)", async (initial) => {
    const { store, config } = cfg(initial);
    const r = new HiddenFileRevealer(fakeInternals(new Disk(), "desktop").a, quietLog(), config);
    r.enable();
    expect(store.showUnsupportedFiles).toBe(true);
    await r.disable();
    expect(store.showUnsupportedFiles).toBe(false);
  });

  it("leaves it on if Brandon already had it on", async () => {
    const { store, config } = cfg(true);
    const r = new HiddenFileRevealer(fakeInternals(new Disk(), "desktop").a, quietLog(), config);
    r.enable();
    await r.disable();
    expect(store.showUnsupportedFiles).toBe(true);
  });

  it("doesn't touch it when Obsidian lacks the internals for hidden files", () => {
    const { store, config } = cfg(false);
    new HiddenFileRevealer({}, quietLog(), config).enable();
    expect(store.showUnsupportedFiles).toBe(false);
  });

  it("a config that can't be changed is logged, and hidden files still work", async () => {
    const { config } = cfg(false, { throwOnSet: true });
    const log = quietLog();
    const r = new HiddenFileRevealer(fakeInternals(new Disk(), "desktop").a, log, config);
    expect(r.enable()).toBe(true);
    await r.disable();
    expect(log.debug.mock.calls.map((c) => c[0])).toEqual([
      'Couldn\'t turn on "Detect all file extensions": read-only',
      'Couldn\'t restore "Detect all file extensions": read-only',
    ]);
  });
});
