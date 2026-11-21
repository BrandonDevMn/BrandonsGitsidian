import { App, Modal, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import { DEFAULT_EXCLUDES } from "../core/paths";
import type BrandonGitsidianPlugin from "../main";

export interface Settings {
  owner: string;
  repo: string;
  branch: string;
  tokenSecretId: string;
  deviceName: string;
  syncOnStartup: boolean;
  syncOnReturn: boolean;
  intervalMinutes: number;
  pushAfterEdits: boolean;
  pushDelaySeconds: number;
  excludes: string[];
  maxFileMB: number;
  logDebug: boolean;
  autoSaveLogNote: boolean;
  paused: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  owner: "BrandonDevMn",
  repo: "Claudian",
  branch: "main",
  tokenSecretId: "",
  deviceName: "Brandon's iPhone",
  syncOnStartup: true,
  syncOnReturn: true,
  intervalMinutes: 5,
  pushAfterEdits: true,
  pushDelaySeconds: 20,
  excludes: [...DEFAULT_EXCLUDES],
  maxFileMB: 20,
  logDebug: true,
  autoSaveLogNote: false,
  paused: false,
};

export class BrandonGitsidianSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BrandonGitsidianPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const log = this.plugin.log;
    containerEl.empty();

    // ---- status --------------------------------------------------------------
    const st = this.plugin.state;
    const status = new Setting(containerEl).setName("Status").setHeading();
    status.setDesc(
      st.baseCommit
        ? `Last sync ${this.plugin.lastSyncText()} · base ${st.baseCommit.slice(0, 7)} · ${Object.keys(st.index).length} files tracked`
        : "Not synced yet",
    );
    if (st.baseCommit) {
      const link = containerEl.createEl("a", {
        text: "Open base commit on GitHub",
        href: `https://github.com/${s.owner}/${s.repo}/commit/${st.baseCommit}`,
      });
      link.setAttr("target", "_blank");
    }
    new Setting(containerEl).setName("Detailed log").addButton((b) =>
      b.setButtonText("Open detailed log").onClick(() => void this.plugin.openLogView()),
    );

    // ---- repository ------------------------------------------------------------
    new Setting(containerEl).setName("Repository").setHeading();
    new Setting(containerEl).setName("Owner").addText((t) =>
      t.setValue(s.owner).onChange(async (v) => {
        s.owner = v.trim();
        log.info("Setting changed: owner");
        await this.plugin.saveAll();
      }),
    );
    new Setting(containerEl).setName("Repository name").addText((t) =>
      t.setValue(s.repo).onChange(async (v) => {
        s.repo = v.trim();
        log.info("Setting changed: repository name");
        await this.plugin.saveAll();
      }),
    );
    new Setting(containerEl).setName("Branch").addText((t) =>
      t.setPlaceholder("main").setValue(s.branch).onChange(async (v) => {
        s.branch = v.trim() || "main";
        log.info("Setting changed: branch");
        await this.plugin.saveAll();
      }),
    );

    const token = new Setting(containerEl)
      .setName("GitHub token")
      .setDesc("Stored in Obsidian's keychain (SecretStorage), never in plugin data.");
    new SecretComponent(this.app, token.controlEl).setValue(s.tokenSecretId).onChange(async (id) => {
      s.tokenSecretId = id ?? "";
      log.info(`Setting changed: token secret ID set to "${s.tokenSecretId}"`);
      await this.plugin.saveAll();
    });
    new Setting(containerEl)
      .setName("How do I make a token?")
      .setDesc(
        'On github.com: Settings → Developer settings → Fine-grained tokens → Generate. Repository access: only this repo. Permissions: "Contents: Read and write" and nothing else. Set an expiry date.',
      );
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Test connection").setCta().onClick(() => void this.plugin.testConnection()),
    );

    // ---- when to sync ----------------------------------------------------------
    new Setting(containerEl).setName("When to sync").setHeading();
    this.toggle("Sync on startup", "syncOnStartup");
    this.toggle("Sync when app returns", "syncOnReturn", "After at least 30 seconds in the background.");
    new Setting(containerEl).setName("Sync interval (minutes)").setDesc("While Obsidian is open. 0 turns it off.").addText((t) =>
      t.setValue(String(s.intervalMinutes)).onChange(async (v) => {
        s.intervalMinutes = Math.max(0, Number(v) || 0);
        log.info(`Setting changed: interval ${s.intervalMinutes} min`);
        await this.plugin.saveAll();
        this.plugin.restartInterval();
      }),
    );
    this.toggle("Push after edits", "pushAfterEdits");
    new Setting(containerEl).setName("Push delay (seconds)").addText((t) =>
      t.setValue(String(s.pushDelaySeconds)).onChange(async (v) => {
        s.pushDelaySeconds = Math.max(5, Number(v) || 20);
        log.info(`Setting changed: push delay ${s.pushDelaySeconds}s`);
        await this.plugin.saveAll();
      }),
    );

    // ---- what to sync ------------------------------------------------------------
    new Setting(containerEl).setName("What to sync").setHeading();
    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc('One per line. "dir/" excludes a folder, "*.tmp" a file type, "private/**" everything under a folder.')
      .addTextArea((t) =>
        t.setValue(s.excludes.join("\n")).onChange(async (v) => {
          s.excludes = v.split("\n").map((x) => x.trim()).filter(Boolean);
          log.info("Setting changed: excluded paths");
          await this.plugin.saveAll();
        }),
      );
    new Setting(containerEl).setName("Maximum file size (MB)").addText((t) =>
      t.setValue(String(s.maxFileMB)).onChange(async (v) => {
        s.maxFileMB = Math.max(1, Number(v) || 20);
        log.info(`Setting changed: max file size ${s.maxFileMB} MB`);
        await this.plugin.saveAll();
      }),
    );
    new Setting(containerEl).setName("Device name").setDesc("Shown in commit messages and the conflict log.").addText((t) =>
      t.setValue(s.deviceName).onChange(async (v) => {
        s.deviceName = v.trim() || "iPhone";
        log.info("Setting changed: device name");
        await this.plugin.saveAll();
      }),
    );

    // ---- logging -----------------------------------------------------------------
    new Setting(containerEl).setName("Logging").setHeading();
    this.toggle("Log debug details", "logDebug", "Every request, hash and classification.", () => {
      log.debugEnabled = s.logDebug;
    });
    this.toggle("Save log to a note after each sync", "autoSaveLogNote", "Writes _brandon-gitsidian/detailed log.md so Claude can read it.");
  }

  private toggle(name: string, key: keyof Settings, desc?: string, after?: () => void): void {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    const setting = new Setting(this.containerEl).setName(name);
    if (desc) setting.setDesc(desc);
    setting.addToggle((t) =>
      t.setValue(Boolean(s[key])).onChange(async (v) => {
        s[key] = v;
        this.plugin.log.info(`Setting changed: ${name} ${v ? "on" : "off"}`);
        after?.();
        await this.plugin.saveAll();
      }),
    );
  }
}

export class ConfirmModal extends Modal {
  constructor(app: App, private heading: string, private body: string, private cta: string, private onYes: () => void) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl("p", { text: this.body });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText(this.cta).setWarning().onClick(() => {
          this.close();
          this.onYes();
        }),
      );
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

/** Ask the user to pick one of several choices. Resolves null if dismissed. */
export function choose(app: App, heading: string, body: string, choices: { label: string; value: string; desc?: string }[]): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const m = new (class extends Modal {
      onOpen(): void {
        this.titleEl.setText(heading);
        for (const para of body.split("\n")) this.contentEl.createEl("p", { text: para });
        for (const c of choices) {
          const s = new Setting(this.contentEl).setName(c.label);
          if (c.desc) s.setDesc(c.desc);
          s.addButton((b) =>
            b.setButtonText("Choose").onClick(() => {
              done = true;
              this.close();
              resolve(c.value);
            }),
          );
        }
      }
      onClose(): void {
        this.contentEl.empty();
        if (!done) resolve(null);
      }
    })(app);
    m.open();
  });
}

export function notice(text: string, onClick?: () => void, timeoutMs = 6000): void {
  const n = new Notice(text, timeoutMs);
  if (onClick) n.messageEl.addEventListener("click", onClick);
}
