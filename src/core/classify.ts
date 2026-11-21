// Three-way change classification. See specs/03-change-detection.feature.

export type Sha = string | undefined; // undefined = file doesn't exist on that side

export type Action =
  | { kind: "unchanged" }
  | { kind: "same" } // both sides ended up identical
  | { kind: "push"; change: "add" | "update" | "delete" }
  | { kind: "pull"; change: "add" | "update" | "delete" }
  | { kind: "conflict"; local: Sha; remote: Sha };

export interface Snapshot {
  base: ReadonlyMap<string, string>;
  local: ReadonlyMap<string, string>;
  remote: ReadonlyMap<string, string>;
}

export function classifyPath(base: Sha, local: Sha, remote: Sha): Action {
  if (local === remote) return local === base ? { kind: "unchanged" } : { kind: "same" };
  if (local === base) return { kind: "pull", change: changeKind(base, remote) };
  if (remote === base) return { kind: "push", change: changeKind(base, local) };
  return { kind: "conflict", local, remote };
}

function changeKind(before: Sha, after: Sha): "add" | "update" | "delete" {
  if (before === undefined) return "add";
  if (after === undefined) return "delete";
  return "update";
}

export function classifyAll(s: Snapshot): Map<string, Action> {
  const paths = new Set<string>([...s.base.keys(), ...s.local.keys(), ...s.remote.keys()]);
  const out = new Map<string, Action>();
  for (const p of [...paths].sort()) out.set(p, classifyPath(s.base.get(p), s.local.get(p), s.remote.get(p)));
  return out;
}
