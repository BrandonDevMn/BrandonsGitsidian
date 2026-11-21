// Shows dot files and folders in Obsidian's file explorer (specs/files/02-hidden-files).
//
// Obsidian has no public API for this. When it finds a dot path it calls the adapter's
// internal `reconcileDeletion`, which removes the path from the vault. We wrap that one
// method: if the dot path really exists on disk we register it instead, and remember it so
// turning the plugin off can hide it again. Everything Obsidian-internal is reached through
// the AdapterInternals interface below and checked first, so if an update renames anything
// the feature switches itself off quietly (log only, no pop-up) and sync keeps working.

import { isHiddenPath } from "./hidden";

export interface StatLike {
  type: "file" | "directory" | string;
}

/** The parts of Obsidian's (desktop or mobile) DataAdapter this relies on. All internal. */
export interface AdapterInternals {
  reconcileDeletion?: (realPath: string, path: string, ...rest: unknown[]) => Promise<void>;
  _exists?: (fullPath: string, path: string) => Promise<boolean>;
  getFullPath?: (path: string) => string;
  getRealPath?: (path: string) => string;
  getFullRealPath?: (realPath: string) => string;
  listRecursive?: (path: string) => Promise<void>;
  /** Desktop. */
  reconcileFileInternal?: (realPath: string, path: string) => Promise<void>;
  /** Mobile. */
  reconcileFileChanged?: (realPath: string, path: string, stat: StatLike) => void;
  reconcileFolderCreation?: (realPath: string, path: string) => Promise<void>;
  fs?: { stat?: (fullRealPath: string) => Promise<StatLike> };
}

export interface RevealLog {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
}

/** Obsidian's vault config (internal getConfig/setConfig), used for "Detect all file extensions". */
export interface VaultConfig {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

const SHOW_ALL_TYPES = "showUnsupportedFiles";

/** Paths that stay hidden: the trash, so deleted notes never show up in search or backlinks (specs/files/02). */
export function staysHidden(path: string): boolean {
  return path === ".trash" || path.startsWith(".trash/");
}

export const UNSUPPORTED_MESSAGE = "Can't show hidden files on this Obsidian version";

/** Which internals are missing; empty means the feature can run. */
export function missingInternals(a: AdapterInternals): string[] {
  const missing: string[] = [];
  for (const k of ["reconcileDeletion", "_exists", "getFullPath", "getRealPath", "listRecursive"] as const) {
    if (typeof a[k] !== "function") missing.push(k);
  }
  const desktop = typeof a.reconcileFileInternal === "function";
  const mobile =
    typeof a.reconcileFileChanged === "function" &&
    typeof a.reconcileFolderCreation === "function" &&
    typeof a.fs?.stat === "function" &&
    typeof a.getFullRealPath === "function";
  if (!desktop && !mobile) missing.push("reconcileFileInternal or reconcileFileChanged");
  return missing;
}

export class HiddenFileRevealer {
  /** True while this class is hiding files itself, so those "delete" events aren't treated as Brandon deleting them. */
  hiding = false;
  /** True while showing files in bulk; their "create" events aren't edits and shouldn't start a sync. */
  scanning = false;
  private revealed = new Set<string>();
  private original: AdapterInternals["reconcileDeletion"] | null = null;
  private previousShowAll: unknown = undefined;

  constructor(
    private adapter: AdapterInternals,
    private log: RevealLog,
    /** Without "Detect all file extensions" the explorer hides dot files of unknown types, like .git/HEAD. */
    private config: VaultConfig | null = null,
  ) {}

  get active(): boolean {
    return this.original !== null;
  }

  /** Paths currently shown because of this class. */
  shown(): string[] {
    return [...this.revealed].sort();
  }

  /** Wraps reconcileDeletion. Returns false (and logs) if this Obsidian lacks the internals. */
  enable(): boolean {
    if (this.active) return true;
    const missing = missingInternals(this.adapter);
    if (missing.length) {
      this.log.warn(`${UNSUPPORTED_MESSAGE} (missing ${missing.join(", ")}); dot files stay hidden`);
      return false;
    }
    const a = this.adapter;
    const original = a.reconcileDeletion as NonNullable<AdapterInternals["reconcileDeletion"]>;
    this.original = original;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    a.reconcileDeletion = async function (this: unknown, realPath: string, path: string, ...rest: unknown[]): Promise<void> {
      if (!self.hiding && isHiddenPath(path) && !staysHidden(path)) {
        try {
          if (await (a._exists as NonNullable<AdapterInternals["_exists"]>)((a.getFullPath as (p: string) => string)(path), path)) {
            self.revealed.add(path);
            await self.register(path);
            return;
          }
          self.revealed.delete(path);
        } catch (e) {
          self.log.debug(`Couldn't show ${path}: ${(e as Error).message}`);
        }
      }
      return original.call(this ?? a, realPath, path, ...rest);
    };
    if (this.config) {
      try {
        this.previousShowAll = this.config.get(SHOW_ALL_TYPES);
        if (this.previousShowAll !== true) {
          this.config.set(SHOW_ALL_TYPES, true);
          this.log.info('Hidden files: turned on "Detect all file extensions" so every dot file is listed (turned back off with the plugin)');
        }
      } catch (e) {
        this.log.debug(`Couldn't turn on "Detect all file extensions": ${(e as Error).message}`);
      }
    }
    this.log.info("Hidden files: showing dot files and folders");
    return true;
  }

  /** Asks Obsidian to rescan the vault so existing dot paths get revealed. Runs in the background. */
  async scan(): Promise<void> {
    if (!this.active) return;
    const started = Date.now();
    this.scanning = true;
    try {
      await (this.adapter.listRecursive as (p: string) => Promise<void>)("");
      this.log.info(`Hidden files: ${this.revealed.size} dot files and folders shown (${Date.now() - started} ms)`);
    } catch (e) {
      this.log.warn(`Hidden files: rescan failed: ${(e as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  /** Shows one path now, e.g. a dot file sync just wrote (iOS has no file watcher to notice it). */
  async reveal(path: string): Promise<void> {
    if (!this.active || !isHiddenPath(path) || staysHidden(path)) return;
    // Its dot parent folders have to be in the vault first.
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (isHiddenPath(folder) && !this.revealed.has(folder)) {
        this.revealed.add(folder);
        await this.safeRegister(folder);
      }
    }
    this.revealed.add(path);
    await this.safeRegister(path);
  }

  /** Restores Obsidian's behaviour and hides everything this class showed (deepest first). */
  async disable(): Promise<void> {
    const original = this.original;
    if (!original) return;
    this.adapter.reconcileDeletion = original;
    this.original = null;
    const paths = [...this.revealed].sort((x, y) => y.split("/").length - x.split("/").length || y.localeCompare(x));
    this.hiding = true;
    try {
      for (const p of paths) {
        try {
          await original.call(this.adapter, (this.adapter.getRealPath as (p: string) => string)(p), p);
        } catch (e) {
          this.log.debug(`Couldn't hide ${p} again: ${(e as Error).message}`);
        }
      }
    } finally {
      this.hiding = false;
      this.revealed.clear();
    }
    if (this.config && this.previousShowAll !== true) {
      try {
        this.config.set(SHOW_ALL_TYPES, this.previousShowAll === undefined ? false : this.previousShowAll);
      } catch (e) {
        this.log.debug(`Couldn't restore "Detect all file extensions": ${(e as Error).message}`);
      }
    }
    this.log.info(`Hidden files: hid ${paths.length} dot files and folders again`);
  }

  private async safeRegister(path: string): Promise<void> {
    try {
      await this.register(path);
    } catch (e) {
      this.log.debug(`Couldn't show ${path}: ${(e as Error).message}`);
    }
  }

  /** Adds the path to Obsidian's vault the way it would for a normal file or folder. */
  private async register(path: string): Promise<void> {
    const a = this.adapter;
    const realPath = (a.getRealPath as (p: string) => string)(path);
    if (a.reconcileFileInternal) {
      await a.reconcileFileInternal(realPath, path);
      return;
    }
    const stat = await (a.fs?.stat as (p: string) => Promise<StatLike>)((a.getFullRealPath as (p: string) => string)(realPath));
    if (stat.type === "directory") await (a.reconcileFolderCreation as NonNullable<AdapterInternals["reconcileFolderCreation"]>)(realPath, path);
    else (a.reconcileFileChanged as NonNullable<AdapterInternals["reconcileFileChanged"]>)(realPath, path, stat);
  }
}
