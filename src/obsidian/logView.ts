import { ItemView, type WorkspaceLeaf } from "obsidian";
import { formatLine, formatLog, type Level, type LogEntry } from "../core/logger";
import type BrandonGitsidianPlugin from "../main";

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
    const copyBtn = buttons.createEl("button", { text: "Copy" });
    copyBtn.addEventListener("click", () => void this.copy(copyBtn));
    const saveBtn = buttons.createEl("button", { text: "Save to note" });
    saveBtn.addEventListener("click", () => void this.plugin.saveLogNote(this.shown()).then(() => flash(saveBtn, "Saved")));
    // No confirmation dialog (specs/sync/13): clearing is immediate.
    buttons.createEl("button", { text: "Clear" }).addEventListener("click", () => {
      this.plugin.log.clear();
      void this.plugin.saveAll();
    });

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

  private async copy(button: HTMLElement): Promise<void> {
    await navigator.clipboard.writeText(formatLog(this.shown(), this.plugin.logHeader()));
    flash(button, "Copied");
  }
}

/** Briefly changes a button's label instead of showing a notice (specs/sync/13). */
function flash(button: HTMLElement, text: string): void {
  const original = button.textContent ?? "";
  button.setText(text);
  window.setTimeout(() => button.setText(original), 1500);
}
