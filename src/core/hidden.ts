// Dot files and folders (specs/files/02-hidden-files, specs/sync/01 "Other dot files and folders sync").

/** True if any part of the path starts with a dot: ".gitignore", ".github/workflows/x.yml", "code/.env". */
export function isHiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith(".") && part !== "." && part !== "..");
}

export interface Listing {
  files: string[];
  folders: string[];
}

/** Lists one folder's direct children as vault paths (Obsidian's DataAdapter.list). */
export type ListFolder = (path: string) => Promise<Listing>;

/**
 * Finds every hidden file Obsidian doesn't index, without walking the whole vault twice:
 * it lists each folder Obsidian already knows about for dot children, then walks those
 * dot folders fully. `skip` keeps it out of ".obsidian/", ".git/" and ".trash/" so a sync
 * never lists git's thousands of objects.
 */
export async function findHiddenFiles(list: ListFolder, knownFolders: readonly string[], skip: (path: string) => boolean): Promise<string[]> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const queue: { path: string; hidden: boolean }[] = knownFolders.map((path) => ({ path, hidden: isHiddenPath(path) }));
  while (queue.length) {
    const { path, hidden } = queue.shift() as { path: string; hidden: boolean };
    if (seen.has(path)) continue;
    seen.add(path);
    let listing: Listing;
    try {
      listing = await list(path);
    } catch {
      continue; // a folder that vanished mid-walk
    }
    for (const f of listing.files) {
      const p = strip(f);
      if ((hidden || isHiddenPath(p)) && !skip(p)) found.add(p);
    }
    for (const d of listing.folders) {
      const p = strip(d);
      // Visible folders are already in knownFolders; only dot folders (and everything under them) need walking here.
      if ((hidden || isHiddenPath(p)) && !skip(p)) queue.push({ path: p, hidden: true });
    }
  }
  return [...found].sort();
}

function strip(path: string): string {
  return path.replace(/^\/+/, "");
}
