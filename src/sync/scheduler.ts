// When syncs run, independent of Obsidian so it can be unit tested. Specs: 07, 10.

export interface RunRequest {
  trigger: string;
  pushOnly?: boolean;
}

/**
 * Single-flight runner: only one sync at a time; triggers during a sync collapse
 * into one queued follow-up (specs/07 "Only one sync at a time").
 */
export class SingleFlight<R> {
  private running: Promise<R> | null = null;
  private queued: RunRequest | null = null;
  paused = false;

  constructor(
    private run: (req: RunRequest) => Promise<R>,
    private isOnline: () => boolean = () => true,
  ) {}

  get busy(): boolean {
    return this.running !== null;
  }

  /** Automatic triggers respect pause and offline; manual ones only respect offline. */
  async request(req: RunRequest, manual = false): Promise<R | null> {
    if (this.paused && !manual) return null;
    if (!this.isOnline()) return null;
    if (this.running) {
      // A full sync request upgrades a queued push-only one.
      if (!this.queued || (this.queued.pushOnly && !req.pushOnly)) this.queued = req;
      return null;
    }
    return this.start(req);
  }

  private async start(req: RunRequest): Promise<R> {
    this.running = this.run(req);
    try {
      return await this.running;
    } finally {
      this.running = null;
      const next = this.queued;
      this.queued = null;
      if (next) void this.start(next);
    }
  }
}

/** Debounce that can be restarted, cancelled and flushed (specs/07 "Push soon after I stop typing"). */
export class Countdown {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private fire: () => void,
    private set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    private clear: (t: ReturnType<typeof setTimeout>) => void = clearTimeout,
  ) {}

  restart(ms: number): void {
    this.cancel();
    this.timer = this.set(() => {
      this.timer = null;
      this.fire();
    }, ms);
  }

  cancel(): void {
    if (this.timer !== null) this.clear(this.timer);
    this.timer = null;
  }

  get pending(): boolean {
    return this.timer !== null;
  }
}

/** Tracks how long the app was in the background (specs/07 "Sync when coming back"). */
export class AwayTracker {
  private hiddenAt: number | null = null;
  constructor(private now: () => number = Date.now) {}
  hidden(): void {
    this.hiddenAt = this.now();
  }
  /** Returns ms spent away, or 0 if we weren't marked hidden. */
  visible(): number {
    const away = this.hiddenAt === null ? 0 : this.now() - this.hiddenAt;
    this.hiddenAt = null;
    return away;
  }
}

/** Show each kind of repeated error once (specs/10 "Errors are shown once"). */
export class ErrorDeduper {
  private last: string | null = null;
  shouldNotify(kind: string | null): boolean {
    if (kind === null) {
      this.last = null;
      return false;
    }
    if (kind === this.last) return false;
    this.last = kind;
    return true;
  }
}

export interface Counts {
  pulled: number;
  pushed: number;
  trashed: number;
  merged: number;
  conflicts: number;
}

/** Short notice text; null means stay quiet (specs/10). */
export function summaryNotice(c: Counts): string | null {
  const fromGitHub = c.pulled + c.trashed;
  const toGitHub = c.pushed;
  if (!fromGitHub && !toGitHub && !c.conflicts && !c.merged) return null;
  const parts = [];
  if (fromGitHub) parts.push(`${fromGitHub} from GitHub`);
  if (toGitHub) parts.push(`${toGitHub} to GitHub`);
  let text = `Synced: ${parts.join(", ") || "merged edits"}`;
  if (c.conflicts) text += `. ${c.conflicts} conflict${c.conflicts === 1 ? "" : "s"}: kept GitHub's version, see the conflict log`;
  return text;
}
