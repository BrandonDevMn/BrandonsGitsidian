// The conflict log note. See specs/06-conflicts.feature.

export const MAX_ENTRIES = 100;
const ENTRY_MARK = "## ";
const HEADER =
  "Conflicts where GitHub's version won over this device. Newest first. Written by BrandonGitsidian.\n";

export interface ConflictEntry {
  when: Date;
  device: string;
  path: string;
  what: "edit discarded" | "deletion undone" | "edit discarded, file deleted on GitHub" | "new file discarded";
  discardedText?: string; // text files only
  discardedSize?: number; // binary files
}

export function formatEntry(e: ConflictEntry): string {
  const lines = [
    `${ENTRY_MARK}${stamp(e.when)} · ${e.device}`,
    `- file: [[${e.path.replace(/\.md$/, "")}]]`,
    `- what happened: ${e.what}; kept GitHub's version`,
  ];
  if (e.discardedText !== undefined) {
    lines.push("", "> [!note]- My discarded version");
    for (const l of e.discardedText.split("\n")) lines.push(`> ${l}`);
  } else if (e.discardedSize !== undefined) {
    lines.push(`- discarded file size: ${e.discardedSize} bytes`);
  }
  return lines.join("\n") + "\n";
}

/** Prepend entries (newest first) and keep at most MAX_ENTRIES. */
export function addEntries(existing: string | null, entries: ConflictEntry[]): string {
  const old = existing ? splitEntries(existing) : [];
  const fresh = [...entries].sort((a, b) => b.when.getTime() - a.when.getTime()).map(formatEntry);
  const kept = [...fresh, ...old].slice(0, MAX_ENTRIES);
  return HEADER + "\n" + kept.join("\n");
}

function splitEntries(doc: string): string[] {
  const parts = doc.split(/\n(?=## )/);
  return parts.filter((p) => p.startsWith(ENTRY_MARK)).map((p) => p.replace(/\n*$/, "\n"));
}

export function stamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
