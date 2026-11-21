// Detailed log. See specs/10-status-and-history.feature "A detailed log I can read in the app".

export type Level = "error" | "warn" | "info" | "debug";

export interface LogEntry {
  t: number; // epoch ms
  level: Level;
  msg: string;
}

export const MAX_LOG_ENTRIES = 2000;
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

export class Logger {
  private entries: LogEntry[];
  private listeners = new Set<() => void>();

  constructor(initial: LogEntry[] = [], private now: () => number = Date.now) {
    this.entries = initial.slice(-MAX_LOG_ENTRIES);
  }

  error(msg: string): void { this.add("error", msg); }
  warn(msg: string): void { this.add("warn", msg); }
  info(msg: string): void { this.add("info", msg); }
  debug(msg: string): void { this.add("debug", msg); }

  private add(level: Level, msg: string): void {
    this.entries.push({ t: this.now(), level, msg: redact(msg) });
    if (this.entries.length > MAX_LOG_ENTRIES) this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
    for (const l of this.listeners) l();
  }

  /** Newest first, filtered to `max` level and above. */
  list(max: Level = "debug"): LogEntry[] {
    return this.entries.filter((e) => LEVEL_RANK[e.level] <= LEVEL_RANK[max]).reverse();
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
    for (const l of this.listeners) l();
  }
}

export function formatLog(entries: LogEntry[]): string {
  return entries.map(formatLine).join("\n");
}

export function formatLine(e: LogEntry): string {
  const d = new Date(e.t);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${ts} ${e.level.toUpperCase().padEnd(5)} ${e.msg}`;
}
