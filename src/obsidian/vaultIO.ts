import { normalizePath, TFile, TFolder, type App } from "obsidian";
import { isTextPath, utf8 } from "../core/blob";
import type { FileStat, VaultIO } from "../sync/engine";

/** VaultIO over Obsidian's Vault API (never casts the adapter; specs/12). */
export class ObsidianVaultIO implements VaultIO {
  constructor(private app: App) {}

  async list(): Promise<FileStat[]> {
    return this.app.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.file(path);
    if (!f) throw new Error(`File not found: ${path}`);
    return new Uint8Array(await this.app.vault.readBinary(f));
  }

  async write(path: string, bytes: Uint8Array): Promise<FileStat> {
    const p = normalizePath(path);
    const existing = this.file(p);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    let file: TFile;
    if (existing) {
      // Text goes through modify() so open editors refresh (specs/04).
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
