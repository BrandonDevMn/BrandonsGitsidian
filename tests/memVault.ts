import type { FileStat, VaultIO } from "../src/sync/engine";

/** In-memory vault. mtime is a counter so edits always change it. */
export class MemVault implements VaultIO {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  trashed: string[] = [];
  writes: string[] = [];
  private clock = 1;

  set(path: string, content: string | Uint8Array): void {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.files.set(path, { bytes, mtime: this.clock++ });
  }
  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? new TextDecoder().decode(f.bytes) : undefined;
  }
  delete(path: string): void {
    this.files.delete(path);
  }

  async list(): Promise<FileStat[]> {
    return [...this.files].map(([path, f]) => ({ path, size: f.bytes.byteLength, mtime: f.mtime }));
  }
  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file ${path}`);
    return f.bytes;
  }
  async write(path: string, bytes: Uint8Array): Promise<FileStat> {
    this.writes.push(path);
    const mtime = this.clock++;
    this.files.set(path, { bytes, mtime });
    return { path, size: bytes.byteLength, mtime };
  }
  async trash(path: string): Promise<void> {
    this.trashed.push(path);
    this.files.delete(path);
  }
}
