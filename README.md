# BrandonGitsidian

An iPhone-first Obsidian plugin that syncs a vault with a GitHub repository, so a person and an AI assistant (Claude) can work on the same notes.

> **Personal plugin.** Built for Brandon's own vault and workflow, not for general use. It won't be submitted to the Obsidian community directory, and there's no support for other setups. Plugin ID: `brandon-gitsidian`.

> Status: **design phase**. There is no code yet. Behaviour is being specified first, as Gherkin feature files in [`specs/`](specs/).

## Why

The workflow this plugin serves:

1. Brandon talks to Claude (often by voice, on his phone) about his tabletop campaigns.
2. Claude edits Markdown notes in a GitHub repo (`BrandonDevMn/Claudian`) using real git.
3. Brandon reads and edits the same notes in Obsidian on his iPhone.

There is no other computer in the loop. The existing git plugins are either desktop-first (Obsidian Git's mobile mode is documented as unstable) or young and loosely specified. BrandonGitsidian aims to be small, predictable, and safe on iOS, and to be explicit about the case where two editors (human and AI) change the same note.

## Design principles

- **iOS first.** No Node.js, no Electron, no in-browser git. Everything goes through Obsidian's `requestUrl` and the GitHub REST API (Git Database endpoints), one file at a time, so memory stays bounded.
- **Never lose a word.** Never force-push, never silently overwrite. When both sides changed a note, keep both and say so.
- **Boring is good.** Sync when the app opens, when it comes back to the foreground, on a timer, and on demand. iOS doesn't allow true background sync, so we don't pretend to.
- **Readable history.** Every push is a normal git commit that a human (or Claude) can read on GitHub.
- **Secrets stay secret.** The GitHub token lives in Obsidian's SecretStorage, never in `data.json`.

## Repository layout

```
README.md            this file
specs/
  README.md          how the specs are organised, tags, glossary
  research.md        findings and sources behind the design
  *.feature          Gherkin specifications, one per capability
```

Planned, once implementation starts: `src/` (TypeScript), `manifest.json`, `esbuild.config.mjs`, and tests that run the feature files.

## Spec-driven workflow

1. Write or change a `.feature` file describing the behaviour.
2. Review it (scenarios are the acceptance criteria).
3. Implement until the scenarios pass.
4. Release.

Scenarios tagged `@mvp` make up the first usable version. `@later` covers ideas that are specified but deferred.

## Installing (future)

Not released yet. When it is, install on iPhone with the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin: add `BrandonDevMn/BrandonsGitsidian` as a beta plugin. Releases will carry `main.js` and `manifest.json`, tagged with the exact version in `manifest.json`.

## Related

- Vault repo this plugin is built for: `BrandonDevMn/Claudian` (private)
