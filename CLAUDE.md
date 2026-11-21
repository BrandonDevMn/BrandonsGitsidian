# Working agreements

- Push to `origin` often. Brandon follows along on GitHub from his phone: commit and push after each meaningful step (a spec, a feature, a fix), not just at the end.
- Specs, research and bug notes are NOT in this repo. They live in the private vault repo `BrandonDevMn/Claudian` under `code/brandon-gitsidian/` (specs in `specs/<feature set>/*.md`, e.g. `specs/sync/`, each a ```gherkin block; bugs in `bugs/`). Clone it next to this repo.
- Spec-driven: change the spec in the vault first, then the code here.
- Test-driven bug fixing: find the bug in the detailed log (`_brandon-gitsidian/detailed log.md` in the vault), write a failing unit test that reproduces it, then fix it.
- GitHub always wins and the plugin never asks Brandon how to sync (no decision dialogs).
- Small commits with clear messages.
- iOS-first: follow spec `12-ios-platform` (no Node/Electron, `requestUrl` only, no regex lookbehind).
