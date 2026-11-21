import { describe, expect, it } from "vitest";
import {
  CODE_LANGUAGES,
  decodeText,
  flattenTokens,
  languageFor,
  NOT_TEXT_MESSAGE,
  plainLines,
  splitLines,
  tooBigMessage,
  VIEWER_EXTENSIONS,
} from "../src/core/codeFiles";

// specs/files/01-code-viewer and specs/files/02-hidden-files
describe("files/01 which files the viewer opens", () => {
  it("opens exactly the fixed list of code and text types", () => {
    expect(Object.keys(CODE_LANGUAGES).sort()).toEqual(
      ["py", "js", "ts", "json", "yaml", "yml", "toml", "sh", "css", "html", "xml", "csv", "txt", "log", "ini"].sort(),
    );
  });

  it("leaves types Obsidian already handles alone", () => {
    for (const ext of ["md", "canvas", "base", "png", "jpg", "pdf", "mp3", "mp4"]) expect(VIEWER_EXTENSIONS).not.toContain(ext);
  });

  it("has no duplicate extensions", () => {
    expect(new Set(VIEWER_EXTENSIONS).size).toBe(VIEWER_EXTENSIONS.length);
  });

  it.each([
    ["py", "python"],
    ["js", "javascript"],
    ["ts", "typescript"],
    ["json", "json"],
    ["yaml", "yaml"],
    ["yml", "yaml"],
    ["toml", "toml"],
    ["sh", "bash"],
    ["css", "css"],
    ["html", "markup"],
    ["xml", "markup"],
    ["ini", "ini"],
    ["PY", "python"],
  ])("highlights .%s as %s", (ext, lang) => {
    expect(languageFor(ext)).toBe(lang);
  });

  it.each(["csv", "txt", "log"])("shows .%s as plain text", (ext) => {
    expect(languageFor(ext)).toBeNull();
  });
});

describe("files/02 dot files without a known extension", () => {
  it.each(["gitignore", "gitattributes", "env", "example"])("opens .%s as plain text", (ext) => {
    expect(VIEWER_EXTENSIONS).toContain(ext);
    expect(languageFor(ext)).toBeNull();
  });

  it("opens .editorconfig as INI", () => {
    expect(languageFor("editorconfig")).toBe("ini");
  });
});

describe("files/01 big and binary files", () => {
  it("renders files up to 1 MB", () => {
    expect(tooBigMessage(1024 * 1024)).toBeNull();
  });

  it("says a 5 MB file is too big to preview", () => {
    expect(tooBigMessage(5 * 1024 * 1024)).toBe("Too big to preview (5 MB). Files over 1 MB aren't shown.");
  });

  it("decodes UTF-8 text and drops a byte-order mark", () => {
    expect(decodeText(new TextEncoder().encode("﻿print('hé')"))).toBe("print('hé')");
  });

  it("treats invalid UTF-8 as not text", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull();
  });

  it("treats bytes with NUL as not text (e.g. a compressed git object)", () => {
    expect(decodeText(new Uint8Array([0x78, 0x01, 0x00, 0x41]))).toBeNull();
    expect(NOT_TEXT_MESSAGE).toBe("This file isn't readable text.");
  });
});

describe("files/01 numbered, highlighted lines", () => {
  it("numbers plain text by line, keeping empty lines", () => {
    const lines = plainLines("a\n\nb\r\n");
    expect(lines.map((l) => l.map((s) => s.text).join(""))).toEqual(["a", "", "b", ""]);
  });

  it("flattens Prism tokens into classed segments, including aliases and nesting", () => {
    const segs = flattenTokens([
      "x = ",
      { type: "string", content: ["'", { type: "interpolation", alias: "punctuation", content: "{y}" }, "'"] },
    ]);
    expect(segs).toEqual([
      { text: "x = ", classes: [] },
      { text: "'", classes: ["token", "string"] },
      { text: "{y}", classes: ["token", "string", "token", "interpolation", "punctuation"] },
      { text: "'", classes: ["token", "string"] },
    ]);
  });

  it("cuts a token that spans lines (a block comment) at each newline", () => {
    const lines = splitLines(flattenTokens(["a\n", { type: "comment", content: "/* one\ntwo */" }, "\nb"]));
    expect(lines).toEqual([
      [{ text: "a", classes: [] }],
      [{ text: "/* one", classes: ["token", "comment"] }],
      [{ text: "two */", classes: ["token", "comment"] }],
      [{ text: "b", classes: [] }],
    ]);
  });
});
