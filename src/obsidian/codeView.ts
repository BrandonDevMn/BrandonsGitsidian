import { FileView, loadPrism, TFile, type WorkspaceLeaf } from "obsidian";
import {
  decodeText,
  flattenTokens,
  languageFor,
  NOT_TEXT_MESSAGE,
  plainLines,
  splitLines,
  tooBigMessage,
  VIEWER_EXTENSIONS,
  type PrismNode,
  type Segment,
} from "../core/codeFiles";
import type { Logger } from "../core/logger";

export const CODE_VIEW = "brandon-gitsidian-code";

interface Prism {
  languages: Record<string, unknown>;
  tokenize(text: string, grammar: unknown): PrismNode[];
}

/** Read-only code and text viewer (specs/files/01-code-viewer). It never writes to the file. */
export class CodeView extends FileView {
  allowNoFile = false;
  private body!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private log: Logger) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string {
    return CODE_VIEW;
  }
  getIcon(): string {
    return "file-code";
  }
  getDisplayText(): string {
    return this.file?.name ?? "Code";
  }
  canAcceptExtension(extension: string): boolean {
    return VIEWER_EXTENSIONS.includes(extension.toLowerCase());
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("bgs-code");
    this.body = this.contentEl.createDiv({ cls: "bgs-code-body" });
    // A sync pulling a new version refreshes the open view (specs/files/01).
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (this.file && f.path === this.file.path) void this.show(this.file);
      }),
    );
  }

  async onLoadFile(file: TFile): Promise<void> {
    await this.show(file);
  }

  async onUnloadFile(): Promise<void> {
    this.body?.empty();
  }

  private async show(file: TFile): Promise<void> {
    if (!this.body) this.body = this.contentEl.createDiv({ cls: "bgs-code-body" });
    const big = tooBigMessage(file.stat.size);
    if (big) return this.message(big);
    const text = decodeText(new Uint8Array(await this.app.vault.readBinary(file)));
    if (text === null) return this.message(NOT_TEXT_MESSAGE);
    const lang = languageFor(file.extension);
    this.render(await this.highlight(text, lang), lang);
  }

  private async highlight(text: string, lang: string | null): Promise<Segment[][]> {
    if (!lang) return plainLines(text);
    try {
      const prism = (await loadPrism()) as Prism;
      const grammar = prism.languages[lang];
      if (!grammar) {
        this.log.debug(`Code viewer: no highlighting for "${lang}" in this Obsidian; showing plain text`);
        return plainLines(text);
      }
      return splitLines(flattenTokens(prism.tokenize(text, grammar)));
    } catch (e) {
      this.log.debug(`Code viewer: highlighting failed, showing plain text: ${(e as Error).message}`);
      return plainLines(text);
    }
  }

  private message(text: string): void {
    this.body.empty();
    this.body.createDiv({ cls: "bgs-code-message", text });
  }

  private render(lines: Segment[][], lang: string | null): void {
    this.body.empty();
    const pre = this.body.createEl("pre", { cls: `bgs-code-pre${lang ? ` language-${lang}` : ""}` });
    const code = pre.createEl("code", { cls: lang ? `language-${lang}` : "" });
    lines.forEach((line, i) => {
      const row = code.createDiv({ cls: "bgs-code-line" });
      row.createSpan({ cls: "bgs-code-num", text: String(i + 1) });
      const content = row.createSpan({ cls: "bgs-code-text" });
      if (!line.length) content.appendText("​"); // keep empty lines their height
      for (const seg of line) {
        if (seg.classes.length) content.createSpan({ cls: seg.classes.join(" "), text: seg.text });
        else content.appendText(seg.text);
      }
    });
  }
}
