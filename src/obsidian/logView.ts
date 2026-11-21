import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { formatLine, formatLog, type Level, type LogEntry } from "../core/logger";
import type BrandonGitsidianPlugin from "../main";
import { ConfirmModal } from "./settings";

export const LOG_VIEW = "brandon-gitsidian-log";

const LEVEL_CHOICES: { label: string; level: Level }[] = [
  { label: "Errors", level: "error" },
  { label: "Warnings", level: "warn" },
  { label: "Info", level: "info" },
  { label: "Everything", level: "debug" },
];

/** In-app detailed log (specs/13). */
export class LogView extends ItemView {
  private level: Level = "info";
  private search = "";
  private run: number | undefined;
  private listEl!: HTMLElement;
  private runBar!: HTMLElement;
  private off: (() => void) | null = null;
  private pending = false;

  constructor(leaf: WorkspaceLeaf, private plugin: BrandonGitsidianPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return LOG_VIEW;
  }
  getDisplayText(): string {
    return "BrandonGitsidian log";
  }
  getIcon(): string {
    return "scroll-text";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("bgs-log");

    const controls = root.createDiv({ cls: "bgs-log-controls" });
    const select = controls.createEl("select");
    for (const c of LEVEL_CHOICES) {
      const o = select.createEl("option", { text: c.label, value: c.level });
      if (c.level === this.level) o.selected = true;
    }
    select.addEventListener("change", () => {
      this.level = select.value as Level;
      this.render();
    });
    const input = controls.createEl("input", { type: "search", placeholder: "Search" });
    input.addEventListener("input", () => {
      this.search = input.value;
      this.render();
    });

    const buttons = root.createDiv({ cls: "bgs-log-buttons" });
    buttons.createEl("button", { text: "Copy" }).addEventListener("click", () => void this.copy());
    buttons.createEl("button", { text: "Save to note" }).addEventListener("click", () => void this.plugin.saveLogNote(this.shown()));
    buttons.createEl("button", { text: "Clear" }).addEventListener("click", () =>
      new ConfirmModal(this.app, "Clear the log?", "All log entries will be removed.", "Clear", () => {
        this.plugin.log.clear();
        void this.plugin.saveAll();
      }).open(),
    );

    this.runBar = root.createDiv({ cls: "bgs-log-run" });
    this.listEl = root.createDiv({ cls: "bgs-log-list" });

    this.off = this.plugin.log.onChange(() => {
      // Batch live updates so a busy sync doesn't re-render per line.
      if (this.pending) return;
      this.pending = true;
      window.setTimeout(() => {
        this.pending = false;
        this.render();
      }, 300);
    });
    this.render();
  }

  async onClose(): Promise<void> {
    this.off?.();
    this.off = null;
  }

  private shown(): LogEntry[] {
    return this.plugin.log.list({ level: this.level, search: this.search, run: this.run });
  }

  private render(): void {
    this.runBar.empty();
    if (this.run !== undefined) {
      this.runBar.createSpan({ text: `Showing sync #${this.run} ` });
      this.runBar.createEl("button", { text: "Show all" }).addEventListener("click", () => {
        this.run = undefined;
        this.render();
      });
    }
    this.listEl.empty();
    const entries = this.shown();
    if (!entries.length) {
      this.listEl.createDiv({ cls: "bgs-log-empty", text: "Nothing logged yet." });
      return;
    }
    for (const e of entries.slice(0, 500)) {
      const row = this.listEl.createDiv({ cls: `bgs-log-row bgs-${e.level}` });
      const d = new Date(e.t);
      row.createSpan({ cls: "bgs-log-time", text: d.toLocaleTimeString() });
      if (e.run !== undefined) {
        const r = row.createEl("a", { cls: "bgs-log-runlink", text: `#${e.run}` });
        r.addEventListener("click", () => {
          this.run = e.run;
          this.render();
        });
      }
      row.createSpan({ cls: "bgs-log-msg", text: e.msg });
      row.setAttr("title", formatLine(e));
    }
  }

  private async copy(): Promise<void> {
    await navigator.clipboard.writeText(formatLog(this.shown(), this.plugin.logHeader()));
    new Notice("Log copied");
  }
}
