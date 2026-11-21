// Reading and writing dot files for sync (specs/sync/01 "Other dot files and folders sync like any other file").
// Obsidian's Vault API only sees files in its index, and dot files are only there while they're shown in the
// file explorer. So sync goes through the public DataAdapter for them, whether or not they're shown.

import { findHiddenFiles, type Listing } from "./hidden";

/** The public DataAdapter methods used here (same on desktop and iOS). */
export interface PublicAdapter {
  list(path: string): Promise<Listing>;
  stat(path: string): Promise<{ size: number; mtime: number; type: string } | null>;
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  trashSystem(path: string): Promise<boolean>;
  trashLocal(path: string): Promise<void>;
}

export interface HiddenStat {
  path: string;
  size: number;
  mtime: number;
}

export class HiddenFileIO {
  constructor(
    private adapter: PublicAdapter,
    /** Paths sync never touches (".obsidian/", ".git/", ".trash/"). */
    private skip: (path: string) => boolean,
    /** Called after a dot file is written, so it can be shown in the file explorer straight away. */
    private onWritten: (path: string) => Promise<void> = async () => {},
  ) {}

  /** Every dot file under the given folders, with size and mtime. */
  async list(knownFolders: readonly string[]): Promise<HiddenStat[]> {
    const paths = await findHiddenFiles((p) => this.adapter.list(p), knownFolders, this.skip);
    const out: HiddenStat[] = [];
    for (const path of paths) {
      const st = await this.adapter.stat(path);
      if (st && st.type === "file") out.push({ path, size: st.size, mtime: st.mtime });
    }
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  async write(path: string, bytes: Uint8Array): Promise<HiddenStat> {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (!(await this.adapter.exists(folder))) await this.adapter.mkdir(folder);
    }
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await this.adapter.writeBinary(path, buf);
    await this.onWritten(path);
    const st = await this.adapter.stat(path);
    return { path, size: st?.size ?? bytes.byteLength, mtime: st?.mtime ?? Date.now() };
  }

  /** Moves a dot file to the system trash, or Obsidian's .trash folder where there is none (iOS). */
  async trash(path: string): Promise<void> {
    if (!(await this.adapter.exists(path))) return;
    if (!(await this.adapter.trashSystem(path))) await this.adapter.trashLocal(path);
  }
}
