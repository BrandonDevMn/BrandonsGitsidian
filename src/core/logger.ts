// Detailed log. See specs/13-detailed-log.feature.

export type Level = "error" | "warn" | "info" | "debug";

export interface LogEntry {
  t: number; // epoch ms
  level: Level;
  msg: string;
  run?: number; // sync run number, when written during a sync
}

export const MAX_LOG_ENTRIES = 2000;
export const LEVELS: Level[] = ["error", "warn", "info", "debug"];
const LEVEL_RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const SECRET_PATTERNS = [
  /(gh[pousr]_[A-Za-z0-9]{20,})/g,
  /(github_pat_[A-Za-z0-9_]{20,})/g,
  /(authorization:\s*)(bearer|token)\s+\S+/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (_m, a: string) => (a.toLowerCase().startsWith("authorization") ? `${a}[redacted]` : "[redacted]"));
  }
  return out;
}

export interface LogFilter {
  level?: Level; // this level and more serious
  search?: string;
  run?: number;
}

export class Logger {
  private entries: LogEntry[];
  private listeners = new Set<() => void>();
  private currentRun: number | undefined;
  private lastRun: number;
  debugEnabled = true;

  constructor(initial: LogEntry[] = [], private now: () => number = Date.now) {
    this.entries = initial.slice(-MAX_LOG_ENTRIES);
    this.lastRun = initial.reduce((m, e) => Math.max(m, e.run ?? 0), 0);
  }

  error(msg: string): void { this.add("error", msg); }
  warn(msg: string): void { this.add("warn", msg); }
  info(msg: string): void { this.add("info", msg); }
  debug(msg: string): void { if (this.debugEnabled) this.add("debug", msg); }

  /** Starts a numbered sync run; entries until endRun() carry its number. */
  startRun(): number {
    this.currentRun = ++this.lastRun;
    return this.currentRun;
  }

  endRun(): void {
    this.currentRun = undefined;
  }

  private add(level: Level, msg: string): void {
    const e: LogEntry = { t: this.now(), level, msg: redact(msg) };
    if (this.currentRun !== undefined) e.run = this.currentRun;
    this.entries.push(e);
    if (this.entries.length > MAX_LOG_ENTRIES) this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
    for (const l of this.listeners) l();
  }

  /** Newest first, unless filtering to a single run (then oldest first, like a story). */
  list(filter: LogFilter | Level = {}): LogEntry[] {
    const f: LogFilter = typeof filter === "string" ? { level: filter } : filter;
    const max = LEVEL_RANK[f.level ?? "debug"];
    const q = f.search?.trim().toLowerCase();
    const out = this.entries.filter(
      (e) =>
        LEVEL_RANK[e.level] <= max &&
        (f.run === undefined || e.run === f.run) &&
        (!q || e.msg.toLowerCase().includes(q)),
    );
    return f.run === undefined ? out.reverse() : out;
  }

  all(): LogEntry[] {
    return [...this.entries];
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  clear(): void {
    this.entries = [];
    this.add("info", "Log cleared");
  }
}

export function formatLog(entries: LogEntry[], header?: string): string {
  const lines = entries.map(formatLine).join("\n");
  return header ? `${header}\n\n${lines}` : lines;
}

export function formatLine(e: LogEntry): string {
  const d = new Date(e.t);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const run = e.run !== undefined ? ` #${e.run}` : "";
  return `${ts} ${e.level.toUpperCase().padEnd(5)}${run} ${e.msg}`;
}
