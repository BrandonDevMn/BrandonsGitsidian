import { describe, expect, it } from "vitest";
import { AwayTracker, Countdown, ConnectionAlerts, SingleFlight, summaryLine } from "../src/sync/scheduler";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("07 only one sync at a time", () => {
  it("queues one follow-up and upgrades push-only to full", async () => {
    const runs: string[] = [];
    let release!: () => void;
    const sf = new SingleFlight<void>(async (req) => {
      runs.push(`${req.trigger}${req.pushOnly ? "(push)" : ""}`);
      if (runs.length === 1) await new Promise<void>((r) => (release = r));
    });
    const first = sf.request({ trigger: "startup" });
    expect(sf.busy).toBe(true);
    await sf.request({ trigger: "hide", pushOnly: true });
    await sf.request({ trigger: "timer" });
    await sf.request({ trigger: "edit" });
    release();
    await first;
    await tick();
    expect(runs).toEqual(["startup", "timer"]);
  });

  it("pause stops automatic syncs but not manual ones; offline stops both", async () => {
    let online = true;
    const runs: string[] = [];
    const sf = new SingleFlight<void>(async (r) => void runs.push(r.trigger), () => online);
    sf.paused = true;
    await sf.request({ trigger: "timer" });
    await sf.request({ trigger: "button" }, true);
    online = false;
    await sf.request({ trigger: "button" }, true);
    expect(runs).toEqual(["button"]);
  });
});

describe("07 push after typing", () => {
  it("restarts on each edit and fires once", () => {
    const pending: (() => void)[] = [];
    let fired = 0;
    const cd = new Countdown(
      () => fired++,
      (fn) => {
        pending.push(fn);
        return pending.length as unknown as ReturnType<typeof setTimeout>;
      },
      (t) => {
        pending[(t as unknown as number) - 1] = () => {};
      },
    );
    cd.restart(20000);
    cd.restart(20000);
    expect(cd.pending).toBe(true);
    pending.forEach((f) => f());
    expect(fired).toBe(1);
    expect(cd.pending).toBe(false);
    cd.cancel();
  });
});

describe("07 coming back to the app", () => {
  it("measures time away", () => {
    let t = 1000;
    const away = new AwayTracker(() => t);
    expect(away.visible()).toBe(0);
    away.hidden();
    t += 45000;
    expect(away.visible()).toBe(45000);
  });
});

describe("10 notices", () => {
  it("never notifies for anything but a connection problem", () => {
    const d = new ConnectionAlerts();
    for (const kind of ["rate-limited", "internal", "not-fast-forward", "too-big", "conflict"]) expect(d.shouldNotify(kind)).toBe(false);
  });

  it.each(["network", "offline", "auth", "forbidden", "not-found", "branch-missing", "no-token"])("notifies for the connection problem %s", (kind) => {
    expect(new ConnectionAlerts().shouldNotify(kind)).toBe(true);
  });

  it("shows a connection problem once, until a sync succeeds in between", () => {
    const d = new ConnectionAlerts();
    expect(d.shouldNotify("network")).toBe(true);
    expect(d.shouldNotify("network")).toBe(false);
    expect(d.shouldNotify("auth")).toBe(false);
    d.succeeded();
    expect(d.shouldNotify("auth")).toBe(true);
  });

  it("summarises a sync for the log, and is quiet when nothing happened", () => {
    expect(summaryLine({ pulled: 0, pushed: 0, trashed: 0, merged: 0, conflicts: 0 })).toBeNull();
    expect(summaryLine({ pulled: 3, pushed: 1, trashed: 0, merged: 0, conflicts: 0 })).toBe("Synced: 3 from GitHub, 1 to GitHub");
    expect(summaryLine({ pulled: 1, pushed: 0, trashed: 0, merged: 0, conflicts: 2 })).toContain("2 conflicts: kept GitHub's version");
    expect(summaryLine({ pulled: 0, pushed: 0, trashed: 0, merged: 1, conflicts: 0 })).toBe("Synced: merged edits");
  });
});
