// See specs/05-push.feature "The commit message says what changed and where".

export interface PushedChange {
  path: string;
  change: "add" | "update" | "delete";
}

const WORD = { add: "added", update: "updated", delete: "deleted" } as const;

export function commitMessage(changes: PushedChange[], device: string, initial = false): string {
  if (initial) return `BrandonGitsidian: initial upload from ${device}`;
  const n = changes.length;
  const title = `BrandonGitsidian: ${n} ${n === 1 ? "note" : "notes"} from ${device}`;
  const body = [...changes]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((c) => `- ${WORD[c.change]}: ${c.path}`)
    .join("\n");
  return `${title}\n\n${body}`;
}
