// Read-only viewer for code and plain text files (specs/files/01-code-viewer, specs/files/02-hidden-files).
// Pure helpers only; the Obsidian view lives in src/obsidian/codeView.ts.

/** Extension → Prism language. null means plain text. The list is fixed on purpose (no setting). */
export const CODE_LANGUAGES: Readonly<Record<string, string | null>> = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  css: "css",
  html: "markup",
  xml: "markup",
  ini: "ini",
  csv: null,
  txt: null,
  log: null,
};

/**
 * Obsidian takes a file's extension from the last dot, so ".gitignore" has the extension "gitignore"
 * and ".env.example" has "example". These are the common dot files, opened as plain text or INI
 * (specs/files/02 "Dot files without a known extension open as plain text").
 */
export const DOTFILE_LANGUAGES: Readonly<Record<string, string | null>> = {
  gitignore: null,
  gitattributes: null,
  gitmodules: "ini",
  gitkeep: null,
  keep: null,
  mailmap: null,
  editorconfig: "ini",
  env: null,
  example: null,
  local: null,
  sample: null,
  npmrc: "ini",
  nvmrc: null,
  prettierrc: null,
  prettierignore: null,
  eslintrc: null,
  eslintignore: null,
  dockerignore: null,
  babelrc: null,
};

export const VIEWER_EXTENSIONS: readonly string[] = [...Object.keys(CODE_LANGUAGES), ...Object.keys(DOTFILE_LANGUAGES)];

/** Files bigger than this aren't rendered (specs/files/01 "Very large files aren't rendered"). */
export const MAX_VIEW_BYTES = 1024 * 1024;

export function languageFor(extension: string): string | null {
  const ext = extension.toLowerCase();
  if (ext in CODE_LANGUAGES) return CODE_LANGUAGES[ext] ?? null;
  if (ext in DOTFILE_LANGUAGES) return DOTFILE_LANGUAGES[ext] ?? null;
  return null;
}

export function tooBigMessage(bytes: number): string | null {
  if (bytes <= MAX_VIEW_BYTES) return null;
  const mb = (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "");
  return `Too big to preview (${mb} MB). Files over 1 MB aren't shown.`;
}

export const NOT_TEXT_MESSAGE = "This file isn't readable text.";

/** Decodes UTF-8 text; null if the bytes aren't valid UTF-8 or contain NUL bytes (binary). */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

// ---- turning Prism tokens into numbered lines ---------------------------------------

/** The shape of Prism's token tree (a string, a Token, or an array of either). */
export type PrismNode = string | PrismToken | PrismNode[];
export interface PrismToken {
  type: string;
  alias?: string | string[];
  content: PrismNode;
}

/** A run of text with the CSS classes Prism gives it. */
export interface Segment {
  text: string;
  classes: string[];
}

export function flattenTokens(node: PrismNode, classes: string[] = []): Segment[] {
  if (typeof node === "string") return node ? [{ text: node, classes }] : [];
  if (Array.isArray(node)) return node.flatMap((n) => flattenTokens(n, classes));
  const alias = node.alias === undefined ? [] : Array.isArray(node.alias) ? node.alias : [node.alias];
  return flattenTokens(node.content, [...classes, "token", node.type, ...alias]);
}

/** Splits segments into lines, so a token that spans lines (a block comment) is cut at each newline. */
export function splitLines(segments: Segment[]): Segment[][] {
  const lines: Segment[][] = [[]];
  for (const seg of segments) {
    const parts = seg.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      const line = lines[lines.length - 1] as Segment[];
      if (part) line.push({ text: part.replace(/\r$/, ""), classes: seg.classes });
    });
  }
  return lines;
}

/** Plain text as lines with no highlighting. */
export function plainLines(text: string): Segment[][] {
  return splitLines([{ text, classes: [] }]);
}
