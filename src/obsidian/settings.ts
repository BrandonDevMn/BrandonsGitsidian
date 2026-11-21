import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import { CHOSEN_SETTINGS, DEFAULT_SETTINGS, loadSettings, type Settings } from "../core/settings";

export { DEFAULT_SETTINGS, loadSettings, CHOSEN_SETTINGS, type Settings };
import type BrandonGitsidianPlugin from "../main";

const ABOUT = [
  "BrandonGitsidian keeps this vault and one GitHub repository in sync, so Brandon (here, in Obsidian on his iPhone) and Claude (on GitHub, with real git) can work on the same notes.",
  "It's deliberately narrow. It's built for exactly one workflow: Brandon talks to Claude about his campaigns, Claude edits the notes in the repo, and the phone keeps up. There's no other computer in the loop, so there's nothing to configure and nothing to decide.",
  "How it behaves: it syncs when Obsidian opens, when you come back to it, every few minutes while it's open, and about 20 seconds after you stop typing. GitHub always wins: if a note changed on both sides and the edits can't be merged, GitHub's version is kept and the phone's version is saved in _brandon-gitsidian/conflict log.md. Notes you delete in Obsidian are deleted on GitHub; notes that go missing any other way are restored from GitHub. It never force-pushes.",
  "Everything it does is written to the detailed log, so Brandon or Claude can see exactly what happened.",
];

export class BrandonGitsidianSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BrandonGitsidianPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const log = this.plugin.log;
    containerEl.empty();

    // ---- what this is ----------------------------------------------------------------
    new Setting(containerEl).setName("BrandonGitsidian").setHeading();
    const about = containerEl.createDiv({ cls: "bgs-about" });
    for (const p of ABOUT) about.createEl("p", { text: p });

    // ---- connect -------------------------------------------------------------------------
    new Setting(containerEl).setName("Connect").setHeading();
    const token = new Setting(containerEl)
      .setName("GitHub token")
      .setDesc(
        'Kept in Obsidian\'s keychain, never in plugin data. To make one on github.com: Settings → Developer settings → Fine-grained tokens → Generate. Repository access: only the notes repo. Permissions: "Contents: Read and write". Set an expiry date.',
      );
    new SecretComponent(this.app, token.controlEl).setValue(s.tokenSecretId).onChange(async (id) => {
      s.tokenSecretId = id ?? "";
      log.info(`Setting changed: token secret ID set to "${s.tokenSecretId}"`);
      await this.plugin.saveAll();
      this.display();
    });

    const repo = new Setting(containerEl).setName("Repository").setDesc("Loading the repositories this token can push to…");
    const status = new Setting(containerEl).setName("Connection").setDesc("Checking…");
    void this.fillRepos(repo, status);

    // ---- state + log -------------------------------------------------------------------
    const st = this.plugin.state;
    new Setting(containerEl)
      .setName("Last sync")
      .setDesc(
        st.baseCommit
          ? `${this.plugin.lastSyncText()} · commit ${st.baseCommit.slice(0, 7)} · ${Object.keys(st.index).length} files tracked`
          : "Not synced yet",
      )
      .addButton((b) => b.setButtonText("Open detailed log").onClick(() => void this.plugin.openLogView()));

    // ---- link to GitHub (bottom) ----------------------------------------------------------
    const foot = containerEl.createDiv({ cls: "bgs-footer" });
    const link = foot.createEl("a", { text: `Open ${s.owner}/${s.repo} on GitHub`, href: `https://github.com/${s.owner}/${s.repo}` });
    link.setAttr("target", "_blank");
  }

  private async fillRepos(row: Setting, status: Setting): Promise<void> {
    const s = this.plugin.settings;
    const repos = await this.plugin.listRepos();
    if (!repos) {
      row.setDesc("Pick a GitHub token above first.");
      status.setDesc(this.plugin.settings.tokenSecretId ? "Couldn't load repositories; see the detailed log." : "Not connected.");
      return;
    }
    row.setDesc(repos.length ? "Pick the notes repository. Its default branch is used." : "This token can't push to any repository.");
    row.addDropdown((d) => {
      const current = `${s.owner}/${s.repo}`;
      if (!repos.some((r) => `${r.owner}/${r.repo}` === current)) d.addOption(current, `${current} (not visible to this token)`);
      for (const r of repos) d.addOption(`${r.owner}/${r.repo}`, `${r.owner}/${r.repo}${r.isPrivate ? " (private)" : ""}`);
      d.setValue(current);
      d.onChange(async (v) => {
        const r = repos.find((x) => `${x.owner}/${x.repo}` === v);
        if (!r) return;
        s.owner = r.owner;
        s.repo = r.repo;
        s.branch = r.defaultBranch;
        this.plugin.log.info(`Setting changed: repository ${s.owner}/${s.repo}@${s.branch}`);
        await this.plugin.saveAll();
        this.display();
      });
    });
    status.setDesc(await this.plugin.checkConnection());
  }
}

/** Yes/no confirmation; only used for clearing the log (never for sync decisions). */
/** The plugin's only pop-up, used just for GitHub connection problems (specs/sync/10). */
export function notice(text: string, onClick?: () => void, timeoutMs = 6000): void {
  const n = new Notice(text, timeoutMs);
  if (onClick) n.messageEl.addEventListener("click", onClick);
}
