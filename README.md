# BrandonGitsidian

An iPhone-first Obsidian plugin that syncs a vault with a GitHub repository, so a person and an AI assistant (Claude) can work on the same notes.

> **Personal plugin.** Built for Brandon's own vault and workflow, not for general use. It won't be submitted to the Obsidian community directory, and there's no support for other setups. Plugin ID: `brandon-gitsidian`.

This repo holds only the code. The specs, research notes and bug notes live in Brandon's private notes vault (`BrandonDevMn/Claudian`, under `code/brandon-gitsidian/`).

## What it does

- **Sync:** keeps the vault and one GitHub repo in step. GitHub always wins, nothing is ever asked, and it never force-pushes.
- **Quiet:** no pop-ups unless the GitHub connection isn't working; everything else is in the detailed log.
- **Code viewer:** code and text files (`.py`, `.js`, `.ts`, `.json`, `.yaml`, `.toml`, `.sh`, `.css`, `.html`, `.xml`, `.ini`, `.csv`, `.txt`, `.log` and common dot files) open read-only with syntax highlighting.
- **Hidden files:** every dot file and folder shows in the file explorer, including `.obsidian`, `.git` and `.trash`. Dot files sync like any other file; `.obsidian`, `.git` and `.trash` never sync.

## Install (iPhone)

With the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, add `BrandonDevMn/BrandonsGitsidian` as a beta plugin. Releases carry `main.js`, `manifest.json` and `styles.css`, tagged with the version in `manifest.json`.

## Develop

```
npm ci
npm test          # unit tests (vitest)
npm run coverage  # tests + coverage thresholds
npm run build     # typecheck, bundle, iOS bundle check
```

Release: Actions → Release → Run workflow.
