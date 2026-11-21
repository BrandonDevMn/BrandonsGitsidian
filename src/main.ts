import { apiVersion, Modal, normalizePath, Platform, Plugin, setIcon, TAbstractFile, TFile, type App } from "obsidian";
import { CONFLICT_LOG_PATH, isExcluded } from "./core/paths";
import { formatLog, Logger, type LogEntry } from "./core/logger";
import { utf8 } from "./core/blob";
import { GitHubClient, GitHubError } from "./github/client";
import { friendly, SyncEngine, type SyncOptions, type SyncResult, type SyncState } from "./sync/engine";
import { AwayTracker, ConnectionAlerts, Countdown, SingleFlight, summaryLine, type RunRequest } from "./sync/scheduler";
import { obsidianHttp } from "./obsidian/http";
import { ObsidianVaultIO } from "./obsidian/vaultIO";
import { BrandonGitsidianSettingTab, DEFAULT_SETTINGS, loadSettings, notice, type Settings } from "./obsidian/settings";
import { LOG_VIEW, LogView } from "./obsidian/logView";
import { CODE_VIEW, CodeView } from "./obsidian/codeView";
import { VIEWER_EXTENSIONS } from "./core/codeFiles";
import { HiddenFileRevealer, type AdapterInternals, type VaultConfig } from "./core/revealer";

const LOG_NOTE_PATH = "_brandon-gitsidian/detailed log.md";
const RETURN_AFTER_MS = 30_000;
const MAX_HISTORY = 50;

interface HistoryItem {
  t: number;
  trigger: string;
  status: string;
  error?: string;
  pulled: string[];
  pushed: string[];
  trashed: string[];
  conflicts: string[];
  commits: { message: string; author: string }[];
}

interface PluginData {
  settings: Settings;
  state: SyncState;
  log: LogEntry[];
  history: HistoryItem[];
  /** Paths deleted or renamed away in Obsidian since the last sync (specs/08). */
  userDeleted: string[];
}

type RibbonState = "idle" | "running" | "dirty" | "error" | "paused";

export default class BrandonGitsidianPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  state: SyncState = { repoKey: "", baseCommit: null, index: {} };
  history: HistoryItem[] = [];
  userDeleted: string[] = [];
  log!: Logger;
  hidden!: HiddenFileRevealer;

  private ribbon!: HTMLElement;
  private runner!: SingleFlight<SyncResult | null>;
  private typing!: Countdown;
  private away = new AwayTracker();
  private alerts = new ConnectionAlerts();
  private dirty = false;
  private lastError: string | null = null;
  private applying = false;
  private lastSyncAt = 0;
  private intervalId: number | null = null;
  private logSaveTimer: number | null = null;

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = loadSettings(data.settings); // only the repo + token are Brandon's choice (specs/01)
    this.userDeleted = data.userDeleted ?? [];
    this.state = data.state ?? { repoKey: this.repoKey(), baseCommit: null, index: {} };
    this.history = data.history ?? [];
    this.log = new Logger(data.log ?? []);
    this.log.debugEnabled = this.settings.logDebug;
    this.log.info(`Plugin loaded (v${this.manifest.version}, Obsidian API ${apiVersion}, ${Platform.isIosApp ? "iOS" : Platform.isMobile ? "mobile" : "desktop"})`);
    this.log.onChange(() => this.scheduleLogSave());

    this.runner = new SingleFlight(
      (req) => this.runSync(req),
      () => navigator.onLine !== false,
      (msg) => this.log.info(msg),
    );
    this.runner.paused = this.settings.paused;
    this.typing = new Countdown(() => void this.runner.request({ trigger: "after edits" }));

    this.registerView(LOG_VIEW, (leaf) => new LogView(leaf, this));
    this.registerCodeViewer();
    // Internal Obsidian API, isolated in core/revealer.ts; it switches itself off quietly if missing (specs/files/02).
    this.hidden = new HiddenFileRevealer(this.app.vault.adapter as unknown as AdapterInternals, this.log, vaultConfig(this.app));
    this.addSettingTab(new BrandonGitsidianSettingTab(this.app, this));

    this.ribbon = this.addRibbonIcon("refresh-cw", "BrandonGitsidian: sync now", () => void this.syncNow("ribbon"));
    this.setRibbon(this.settings.paused ? "paused" : "idle");

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow("command") });
    this.addCommand({ id: "preview-sync", name: "Preview sync", callback: () => void this.preview() });
    this.addCommand({ id: "toggle-pause", name: "Pause or resume sync", callback: () => void this.togglePause() });
    this.addCommand({ id: "open-detailed-log", name: "Open detailed log", callback: () => void this.openLogView() });
    this.addCommand({ id: "open-sync-log", name: "Open sync log", callback: () => new HistoryModal(this.app, this).open() });
    this.addCommand({ id: "save-log-to-note", name: "Save detailed log to note", callback: () => void this.saveLogNote(this.log.list()) });

    // obsidian://brandon-gitsidian?action=sync (iOS Shortcuts, specs/07)
    this.registerObsidianProtocolHandler("brandon-gitsidian", (params) => {
      this.log.info(`Opened by URL with action "${params.action ?? ""}"`);
      if (params.action === "sync" || !params.action) void this.syncNow("shortcut URL");
    });

    this.app.workspace.onLayoutReady(() => {
      // Register after layout so the initial "create" event per file isn't treated as an edit (specs/07).
      const onChange = (f: TAbstractFile) => this.onVaultChange(f);
      this.registerEvent(this.app.vault.on("modify", onChange));
      this.registerEvent(this.app.vault.on("create", onChange));
      this.registerEvent(
        this.app.vault.on("delete", (f) => {
          this.noteUserDelete(f, f.path);
          onChange(f);
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (f, oldPath) => {
          this.noteUserDelete(f, oldPath);
          onChange(f);
        }),
      );
      if (this.settings.syncOnStartup) void this.runner.request({ trigger: "startup" });
      // Show dot files in the background so Obsidian stays usable (specs/files/02).
      if (this.hidden.enable()) void this.hidden.scan();
    });

    this.registerDomEvent(document, "visibilitychange", () => this.onVisibility());
    this.restartInterval();
  }

  /** Opens code and text files read-only (specs/files/01). Types another plugin already owns are skipped. */
  private registerCodeViewer(): void {
    this.registerView(CODE_VIEW, (leaf) => new CodeView(leaf, this.log));
    const skipped: string[] = [];
    for (const ext of VIEWER_EXTENSIONS) {
      try {
        this.registerExtensions([ext], CODE_VIEW);
      } catch {
        skipped.push(ext);
      }
    }
    this.log.info(`Code viewer: opens ${VIEWER_EXTENSIONS.length - skipped.length} file types read-only`);
    if (skipped.length) this.log.warn(`Code viewer: another plugin already opens .${skipped.join(", .")}, so those are left to it`);
  }

  onunload(): void {
    this.log.info("Plugin unloaded");
    this.typing?.cancel();
    void this.hidden?.disable(); // hide dot files again; nothing on disk changes (specs/files/02)
    void this.saveAll();
  }

  // ---- triggers --------------------------------------------------------------------

  private onVaultChange(f: TAbstractFile): void {
    if (this.applying || this.hidden.scanning || this.hidden.hiding || !(f instanceof TFile)) return;
    if (isExcluded(f.path, this.settings.excludes) || f.path === LOG_NOTE_PATH) return;
    this.dirty = true;
    if (!this.runner.busy) this.setRibbon("dirty");
    if (this.settings.pushAfterEdits) {
      const first = !this.typing.pending;
      this.typing.restart(this.settings.pushDelaySeconds * 1000);
      // Log the first edit of a burst at info, the rest at debug, so the log stays readable.
      const msg = `Edit detected in ${f.path}; push scheduled in ${this.settings.pushDelaySeconds}s after typing stops`;
      if (first) this.log.info(msg);
      else this.log.debug(msg);
    } else {
      this.log.debug(`Edit detected in ${f.path}; will sync on the next trigger`);
    }
  }

  /** Only deletions Brandon makes in Obsidian may delete files on GitHub; anything else that goes missing is restored (specs/08). */
  private noteUserDelete(f: TAbstractFile, path: string): void {
    // Hiding dot files again (plugin off) removes them from the vault without deleting anything.
    if (this.applying || this.hidden.hiding || !(f instanceof TFile)) return;
    if (isExcluded(path, this.settings.excludes) || path === LOG_NOTE_PATH) return;
    if (!this.userDeleted.includes(path)) this.userDeleted.push(path);
    this.log.info(`You deleted or renamed ${path} in Obsidian; it will be deleted on GitHub at the next sync`);
    void this.saveAll();
  }

  private onVisibility(): void {
    if (document.hidden) {
      this.away.hidden();
      this.log.info("Obsidian went to the background");
      if (this.dirty) {
        this.typing.cancel();
        this.log.info("Unsynced edits: trying a quick push before iOS suspends the app");
        void this.runner.request({ trigger: "leaving app", pushOnly: true });
      }
      void this.saveAll();
    } else {
      const away = this.away.visible();
      this.log.info(`Obsidian came back after ${Math.round(away / 1000)}s`);
      if (this.settings.syncOnReturn && away >= RETURN_AFTER_MS) void this.runner.request({ trigger: "app returned" });
      else if (this.settings.syncOnReturn) this.log.debug(`No sync on return: away less than ${RETURN_AFTER_MS / 1000}s`);
    }
  }

  restartInterval(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    this.intervalId = null;
    if (this.settings.intervalMinutes <= 0) return;
    this.intervalId = window.setInterval(() => {
      if (document.hidden) return; // paused in the background (specs/07)
      if (Date.now() - this.lastSyncAt >= this.settings.intervalMinutes * 60_000) void this.runner.request({ trigger: "timer" });
    }, 30_000);
    this.registerInterval(this.intervalId);
  }

  async syncNow(trigger: string): Promise<void> {
    this.typing.cancel();
    if (navigator.onLine === false) {
      this.log.warn("Sync now: the device is offline");
      this.reportError("offline", "You're offline. BrandonGitsidian will sync when you're connected.");
      return;
    }
    if (this.runner.busy) this.log.info("A sync is already running; another will follow it");
    await this.runner.request({ trigger }, true);
  }

  private async togglePause(): Promise<void> {
    this.settings.paused = !this.settings.paused;
    this.runner.paused = this.settings.paused;
    this.log.info(this.settings.paused ? "Automatic sync paused" : "Automatic sync resumed");
    this.setRibbon(this.settings.paused ? "paused" : this.dirty ? "dirty" : "idle");
    await this.saveAll();
  }

  // ---- running a sync --------------------------------------------------------------

  private engine(): SyncEngine | null {
    const s = this.settings;
    const token = s.tokenSecretId ? this.app.secretStorage.getSecret(s.tokenSecretId) : null;
    if (!token) {
      this.log.error(s.tokenSecretId ? `No token found in the keychain under "${s.tokenSecretId}"` : "No GitHub token chosen in settings");
      this.reportError("no-token", "Pick a GitHub token in BrandonGitsidian settings first.");
      return null;
    }
    const client = new GitHubClient({ owner: s.owner, repo: s.repo, token, http: obsidianHttp, log: this.log });
    return new SyncEngine(
      new ObsidianVaultIO(
        this.app,
        (p) => isExcluded(p, s.excludes),
        (p) => this.hidden.reveal(p),
      ),
      client,
      { branch: s.branch, excludes: s.excludes, maxFileBytes: s.maxFileMB * 1024 * 1024, device: s.deviceName },
      this.log,
      () => this.state,
      async (st) => {
        this.state = st;
        await this.saveAll(); // one write: base + index together (specs/08)
      },
    );
  }

  private async runSync(req: RunRequest): Promise<SyncResult | null> {
    if (this.state.baseCommit && this.state.repoKey !== this.repoKey()) {
      // Never ask: a different repo just means a fresh first sync where GitHub wins (specs/01).
      this.log.warn(`Repository changed from ${this.state.repoKey} to ${this.repoKey()}; starting fresh with a first sync`);
      this.userDeleted = [];
      await this.resetSyncState();
    }
    const engine = this.engine();
    if (!engine) return null;

    this.setRibbon("running");
    this.applying = true;
    this.dirty = false;
    const deleted = [...this.userDeleted];
    let result: SyncResult;
    try {
      result = await engine.sync({ trigger: req.trigger, pushOnly: req.pushOnly, userDeleted: deleted });
    } finally {
      this.applying = false;
    }
    if (result.status === "ok" || result.status === "nothing-to-do") {
      this.userDeleted = this.userDeleted.filter((p) => !deleted.includes(p)); // sent (or no longer relevant)
    }
    if (result.status === "skipped" && req.pushOnly) this.dirty = true;
    await this.afterSync(req, result);
    return result;
  }

  private async afterSync(req: RunRequest, r: SyncResult): Promise<void> {
    this.lastSyncAt = Date.now();
    if (r.status === "error" && r.error) {
      this.reportError(r.error.kind, r.error.message);
      if (r.error.kind === "auth") {
        this.runner.paused = true; // until the token is fixed (specs/09)
        this.log.warn("Automatic sync paused until the token is fixed");
      }
    } else {
      this.lastError = null;
      if (r.status === "ok" || r.status === "nothing-to-do") this.alerts.succeeded();
      if (!this.settings.paused) this.runner.paused = false;
      // No pop-ups for normal syncs; the outcome goes to the log only (specs/sync/10).
      const text = summaryLine({ pulled: r.pulled.length, pushed: r.pushed.length, trashed: r.trashed.length, merged: r.merged.length, conflicts: r.conflicts.length });
      if (text) this.log.info(text);
      for (const s of r.skipped) this.log.warn(`Skipped ${s.path} (${s.reason})`);
    }
    if (r.status !== "skipped") {
      this.history.unshift({
        t: Date.now(),
        trigger: req.trigger,
        status: r.status,
        error: r.error?.message,
        pulled: r.pulled,
        pushed: r.pushed,
        trashed: r.trashed,
        conflicts: r.conflicts,
        commits: r.remoteCommits,
      });
      this.history.length = Math.min(this.history.length, MAX_HISTORY);
    }
    this.setRibbon(this.lastError ? "error" : this.settings.paused ? "paused" : this.dirty ? "dirty" : "idle");
    if (this.settings.autoSaveLogNote && (r.pulled.length || r.pushed.length || r.error)) await this.saveLogNote(this.log.list(), false);
    await this.saveAll();
  }

  /** Errors update the ribbon and the log; only a broken GitHub connection gets a notice, once (specs/sync/10). */
  private reportError(kind: string, message: string): void {
    this.lastError = message;
    this.setRibbon("error");
    if (this.alerts.shouldNotify(kind)) notice(message, () => this.openSettings(), 10000);
    else this.log.debug(`No notice for "${kind}": not a connection problem, or already shown`);
  }

  openSettings(): void {
    // `setting` isn't in the public API types; if it's missing the notice simply does nothing on tap.
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    if (!setting) return;
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  private client(): GitHubClient | null {
    const s = this.settings;
    const token = s.tokenSecretId ? this.app.secretStorage.getSecret(s.tokenSecretId) : null;
    return token ? new GitHubClient({ owner: s.owner, repo: s.repo, token, http: obsidianHttp, log: this.log }) : null;
  }

  /** Repositories the token can push to, or null if there's no token or GitHub can't be reached. */
  async listRepos(): Promise<{ owner: string; repo: string; defaultBranch: string; isPrivate: boolean }[] | null> {
    const client = this.client();
    if (!client) return null;
    try {
      return await client.listRepos();
    } catch (e) {
      this.log.error(`Couldn't list repositories: ${e instanceof GitHubError ? friendly(e) : (e as Error).message}`);
      return null;
    }
  }

  /** Checks the chosen repo and token; returns a sentence for the settings screen (specs/01). */
  async checkConnection(): Promise<string> {
    const s = this.settings;
    const client = this.client();
    if (!client) return "Pick a GitHub token in settings first.";
    if (navigator.onLine === false) return "You're offline. Try again when you're connected.";
    try {
      const info = await client.repoInfo();
      if (!info.canPush) return 'This token is read-only. Give it "Contents: Read and write" access.';
      const head = await client.branchHead(s.branch);
      if (head === null) return `Branch "${s.branch}" not found on GitHub.`;
      this.log.info(`Connection OK: ${s.owner}/${s.repo} (${s.branch})${head === "empty" ? ", repository is empty" : ""}`);
      return `Connected to ${s.owner}/${s.repo} (${s.branch}). ${client.rate.remaining ?? "?"} API requests left this hour.`;
    } catch (e) {
      const msg =
        e instanceof GitHubError
          ? e.kind === "auth"
            ? "GitHub didn't accept this token. Create a new one and try again."
            : e.kind === "not-found"
              ? `Can't see ${s.owner}/${s.repo}. Check the token's repo access.`
              : friendly(e)
          : (e as Error).message;
      this.log.error(`Connection check failed: ${msg}`);
      return msg;
    }
  }

  private async preview(): Promise<void> {
    const engine = this.engine();
    if (!engine) return;
    const r = await engine.sync({ trigger: "preview", dryRun: true });
    // Written to the log, not shown in a pop-up (specs/sync/08).
    if (r.error) this.log.warn(`Preview: ${r.error.message}`);
    else if (!r.preview?.length) this.log.info("Preview: nothing to sync");
    else for (const p of r.preview) this.log.info(`Preview: would ${p.action} ${p.path}`);
    this.log.info("Preview finished; nothing was changed");
    await this.openLogView();
  }

  // ---- state, log, UI ------------------------------------------------------------------

  repoKey(): string {
    return `${this.settings.owner}/${this.settings.repo}@${this.settings.branch}`;
  }

  async resetSyncState(): Promise<void> {
    this.state = { repoKey: this.repoKey(), baseCommit: null, index: {} };
    this.log.warn(`Sync state reset for ${this.state.repoKey}`);
    await this.saveAll();
  }

  lastSyncText(): string {
    const last = this.history.find((h) => h.status === "ok" || h.status === "nothing-to-do");
    return last ? new Date(last.t).toLocaleString() : "never";
  }

  logHeader(): string {
    return `BrandonGitsidian ${this.manifest.version} · Obsidian API ${apiVersion} · ${Platform.isIosApp ? "iOS" : Platform.isMobile ? "mobile" : "desktop"} · ${this.repoKey()}`;
  }

  async saveLogNote(entries: LogEntry[], announce = true): Promise<boolean> {
    const path = normalizePath(LOG_NOTE_PATH);
    const text = "```\n" + formatLog(entries, this.logHeader()) + "\n```\n";
    const io = new ObsidianVaultIO(this.app);
    await io.write(path, utf8.encode(text));
    if (announce) this.log.info(`Saved log to ${path}`);
    return true;
  }

  async openLogView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(LOG_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getLeaf(true);
    if (!existing) await leaf.setViewState({ type: LOG_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private setRibbon(state: RibbonState): void {
    if (!this.ribbon) return;
    this.ribbon.removeClass("bgs-ribbon-running", "bgs-ribbon-dirty");
    const icon = state === "error" ? "alert-triangle" : state === "paused" ? "pause-circle" : "refresh-cw";
    setIcon(this.ribbon, icon);
    if (state === "running") this.ribbon.addClass("bgs-ribbon-running");
    if (state === "dirty") this.ribbon.addClass("bgs-ribbon-dirty");
    this.ribbon.setAttr("aria-label", `BrandonGitsidian: ${state === "error" && this.lastError ? this.lastError : state}`);
  }

  private scheduleLogSave(): void {
    if (this.logSaveTimer !== null) return;
    this.logSaveTimer = window.setTimeout(() => {
      this.logSaveTimer = null;
      void this.saveAll();
    }, 5000);
  }

  async saveAll(): Promise<void> {
    const data: PluginData = { settings: this.settings, state: this.state, log: this.log.all(), history: this.history, userDeleted: this.userDeleted };
    await this.saveData(data);
  }
}

class HistoryModal extends Modal {
  constructor(app: App, private plugin: BrandonGitsidianPlugin) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText("Sync log");
    const { contentEl } = this;
    if (!this.plugin.history.length) contentEl.createEl("p", { text: "No syncs yet." });
    for (const h of this.plugin.history) {
      const box = contentEl.createDiv({ cls: "bgs-history" });
      box.createEl("strong", { text: `${new Date(h.t).toLocaleString()} · ${h.trigger} · ${h.status}` });
      if (h.error) box.createEl("div", { text: h.error, cls: "bgs-error" });
      for (const c of h.commits) box.createEl("div", { text: `GitHub: "${c.message}" by ${c.author}` });
      const files: [string, string[]][] = [["pulled", h.pulled], ["pushed", h.pushed], ["trashed", h.trashed], ["conflict", h.conflicts]];
      for (const [label, list] of files) {
        for (const p of list) {
          const a = box.createEl("a", { text: `${label}: ${p}` });
          a.addEventListener("click", () => {
            this.close();
            void this.app.workspace.openLinkText(p, "");
          });
          box.createEl("br");
        }
      }
    }
    if (this.plugin.history.length) {
      const link = contentEl.createEl("a", { text: `Conflict log: ${CONFLICT_LOG_PATH}` });
      link.addEventListener("click", () => {
        this.close();
        void this.app.workspace.openLinkText(CONFLICT_LOG_PATH, "");
      });
    }
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

/** Obsidian's internal vault config, if this version has it. */
function vaultConfig(app: App): VaultConfig | null {
  const v = app.vault as unknown as { getConfig?: (k: string) => unknown; setConfig?: (k: string, val: unknown) => void };
  if (typeof v.getConfig !== "function" || typeof v.setConfig !== "function") return null;
  return { get: (k) => v.getConfig!(k), set: (k, val) => v.setConfig!(k, val) };
}
