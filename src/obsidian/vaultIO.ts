import { normalizePath, TFile, TFolder, type App } from "obsidian";
import { isTextPath, utf8 } from "../core/blob";
import { isHiddenPath } from "../core/hidden";
import { HiddenFileIO, type PublicAdapter } from "../core/hiddenIO";
import type { FileStat, VaultIO } from "../sync/engine";

/**
 * VaultIO over Obsidian's Vault API (never casts the adapter to a desktop file system; specs/sync/12).
 * Dot files go through the public DataAdapter, because Obsidian only indexes them while they're
 * shown in the file explorer (specs/sync/01, specs/files/02).
 */
export class ObsidianVaultIO implements VaultIO {
  private hidden: HiddenFileIO;

  constructor(
    private app: App,
    skip: (path: string) => boolean = () => false,
    onHiddenWritten?: (path: string) => Promise<void>,
  ) {
    this.hidden = new HiddenFileIO(app.vault.adapter as unknown as PublicAdapter, skip, onHiddenWritten);
  }

  async list(): Promise<FileStat[]> {
    const byPath = new Map<string, FileStat>();
    for (const f of this.app.vault.getFiles()) byPath.set(f.path, { path: f.path, size: f.stat.size, mtime: f.stat.mtime });
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .map((f) => (f.isRoot() ? "" : f.path));
    for (const h of await this.hidden.list(folders)) if (!byPath.has(h.path)) byPath.set(h.path, h);
    return [...byPath.values()];
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.file(path);
    if (f) return new Uint8Array(await this.app.vault.readBinary(f));
    if (isHiddenPath(path)) return this.hidden.read(normalizePath(path));
    throw new Error(`File not found: ${path}`);
  }

  async write(path: string, bytes: Uint8Array): Promise<FileStat> {
    const p = normalizePath(path);
    const existing = this.file(p);
    if (!existing && isHiddenPath(p)) return this.hidden.write(p, bytes);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    let file: TFile;
    if (existing) {
      // Text goes through modify() so open editors refresh (specs/sync/04).
      if (isTextPath(p)) await this.app.vault.modify(existing, utf8.decode(bytes));
      else await this.app.vault.modifyBinary(existing, buf);
      file = existing;
    } else {
      await this.ensureFolder(p);
      file = isTextPath(p) ? await this.app.vault.create(p, utf8.decode(bytes)) : await this.app.vault.createBinary(p, buf);
    }
    return { path: file.path, size: file.stat.size, mtime: file.stat.mtime };
  }

  async trash(path: string): Promise<void> {
    const f = this.file(path);
    if (f) await this.app.fileManager.trashFile(f); // respects the user's "Deleted files" setting
    else if (isHiddenPath(path)) await this.hidden.trash(normalizePath(path));
  }

  private file(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? f : null;
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(cur);
      if (!existing) await this.app.vault.createFolder(cur);
      else if (!(existing instanceof TFolder)) throw new Error(`${cur} is a file, not a folder`);
    }
  }
}
