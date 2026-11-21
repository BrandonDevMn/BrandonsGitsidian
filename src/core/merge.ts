// Three-way line merge (diff3-style). See specs/06-conflicts.feature
// "Edits to different parts of a Markdown note are merged, not a conflict".
// Conservative: edits that overlap or touch the same spot are a conflict.

export type MergeResult = { ok: true; text: string } | { ok: false };

interface Hunk {
  start: number; // base line index where the change begins
  end: number; // base line index (exclusive) where it ends
  lines: string[]; // replacement lines
}

const MAX_LINES = 4000;

export function mergeText(base: string, mine: string, theirs: string): MergeResult {
  if (mine === theirs) return { ok: true, text: mine };
  if (mine === base) return { ok: true, text: theirs };
  if (theirs === base) return { ok: true, text: mine };

  const b = base.split("\n");
  const a = mine.split("\n");
  const t = theirs.split("\n");
  if (b.length > MAX_LINES || a.length > MAX_LINES || t.length > MAX_LINES) return { ok: false };

  const ha = hunks(b, a);
  const ht = hunks(b, t);

  const merged: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < ha.length || j < ht.length) {
    const x = ha[i];
    const y = ht[j];
    if (x && y && touches(x, y)) {
      if (x.start === y.start && x.end === y.end && x.lines.join("\n") === y.lines.join("\n")) {
        merged.push(x);
        i++;
        j++;
        continue;
      }
      return { ok: false };
    }
    if (y === undefined || (x !== undefined && x.start <= y.start)) {
      merged.push(x as Hunk);
      i++;
    } else {
      merged.push(y);
      j++;
    }
  }

  const out: string[] = [];
  let pos = 0;
  for (const h of merged) {
    out.push(...b.slice(pos, h.start), ...h.lines);
    pos = h.end;
  }
  out.push(...b.slice(pos));
  return { ok: true, text: out.join("\n") };
}

function touches(x: Hunk, y: Hunk): boolean {
  return x.start <= y.end && y.start <= x.end;
}

/** Changed regions of `next` relative to `base`, via an LCS alignment. */
function hunks(base: string[], next: string[]): Hunk[] {
  const n = base.length;
  const m = next.length;
  // lcs[i][j] = LCS length of base[i..] and next[j..]
  const lcs: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) lcs.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint16Array;
    const below = lcs[i + 1] as Uint16Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = base[i] === next[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
    }
  }

  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const flush = () => {
    if (open) out.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === next[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || (lcs[i] as Uint16Array)[j + 1]! >= (lcs[i + 1] as Uint16Array)[j]!)) {
      open ??= { start: i, end: i, lines: [] };
      open.lines.push(next[j] as string);
      j++;
    } else {
      open ??= { start: i, end: i, lines: [] };
      i++;
      open.end = i;
    }
  }
  flush();
  return out;
}
