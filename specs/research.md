# Research notes

What we learned about building a GitHub sync plugin for Obsidian on iOS, and the design decision each finding drives. Gathered 2026-11-21.

## Obsidian on iOS

| Finding | Design consequence |
| --- | --- |
| Node.js and Electron APIs aren't available on mobile; calling them (even from a dependency) crashes the plugin. `isDesktopOnly: true` blocks mobile installs. | No Node built-ins, no Electron, no native git. `isDesktopOnly: false`. |
| Regex lookbehind only works on iOS 16.4+. | Lint rule: no lookbehind in source or dependencies. |
| Plugin guidelines: don't cast `Vault.adapter` to `FileSystemAdapter` (on mobile it's a `CapacitorAdapter`); use `Platform`, not `process.platform`; use `requestUrl`, not `fetch`/axios. | All HTTP goes through `requestUrl`. Platform checks via `Platform.isIosApp`. |
| Mobile `requestUrl` struggles with large bodies (reports of crashes around 20–50 MB). | Default max file size 20 MB; bigger files are skipped with a warning. |
| Obsidian Git (3.4M downloads) says its mobile implementation is "very unstable" and recommends other services. Vault Sync (REST) explains why: isomorphic-git loads whole packfiles into memory and the iOS WebView kills the app. | Don't use git's wire protocol. Use GitHub's REST Git Database API, one blob at a time. |
| Files in hidden folders aren't indexed by the Vault API; only the Adapter API sees them. Vault emits `create` for every existing file at load, so handlers should register after layout is ready. | Sync only vault-visible files by default; `.obsidian/` is excluded. Register vault events in `onLayoutReady`. |
| `SecretStorage` (`app.secretStorage`, API 1.11.4+) gives plugins a shared keychain with `getSecret`, `setSecret`, `listSecrets`, plus a `SecretComponent` for settings UI. Reports say it's shared across vaults on mobile but vault-scoped on desktop. | Token stored in SecretStorage under a user-chosen ID. `minAppVersion` ≥ 1.11.4. |
| iOS suspends Obsidian shortly after it leaves the foreground; Obsidian can't sync in the background, and edits made just before switching apps can be left unsynced. | Sync on open, on return to foreground, on a timer while open, and on demand. Best-effort quick push when the app is hidden. Never promise background sync. |
| BRAT (1.1M downloads) installs beta plugins from a GitHub repo; releases must contain `main.js` and `manifest.json` and be tagged with the exact manifest version (e.g. `0.1.0`, not `v0.1.0`). | Release process: tag = manifest version, assets attached. |

## GitHub REST API

| Finding | Design consequence |
| --- | --- |
| The Git Database API can read and write blobs, trees and commits, and update refs, which "allows you to reimplement a lot of Git functionality ... without having Git installed." To commit: get head commit → its tree → post new blobs → post a tree → post a commit with the old head as parent → update the branch ref. | That's exactly the push algorithm (see `05-push.feature`). |
| Create-tree with `base_tree` overlays entries on an existing tree; without it, every file not listed is deleted. `sha: null` deletes a path (and errors if the path doesn't exist). | Always pass `base_tree` = remote head's tree. Deletions only for paths that exist remotely. |
| Recursive get-tree caps at 100,000 entries / 7 MB and sets `truncated: true`; then you must walk subtrees. | Handle `truncated` by walking subtrees non-recursively. |
| The Git Database API returns 409 on an empty repository; the contents API can create the first file to initialise it. | First push to an empty repo uses `PUT /contents/{path}` once, then the normal flow. |
| Authenticated REST limit is 5,000 requests/hour per user (shared across PATs and apps). Secondary limits: no more than ~80 content-creating requests per minute, ~500 per hour. | Count requests per sync; throttle blob creation; honour `retry-after` / `x-ratelimit-reset`. A big first push may take several runs. |
| Fine-grained PATs can be scoped to one repo; create-tree needs "Contents: write", get-tree needs "Contents: read". | Setup asks for a fine-grained PAT, Contents read/write, this repo only. |
| OAuth device flow exists (user enters a code at github.com/login/device). It needs a registered OAuth/GitHub App client ID, and GitHub's token endpoint doesn't support CORS preflight. `requestUrl` sidesteps CORS. | Device flow is `@later`; PAT for the MVP. |

## Existing plugins we learned from

- **Git Vault Sync**: GitHub API engine on mobile, conflict dialog (keep local / keep remote / edit), skips `.obsidian/`.
- **Vault Sync (REST)**: one file at a time; no merge engine, last pull-then-push wins; caps compare calls at 300 files. We want real conflict handling instead.
- **Hybrid Git Sync**: native git on desktop, provider APIs on mobile; PAT with broad repo scope.

## Sources

- Obsidian, Mobile development: https://docs.obsidian.md/Plugins/Getting+started/Mobile+development
- Obsidian, Plugin guidelines: https://docs.obsidian.md/oo/plugin
- Obsidian, Submission requirements: https://docs.obsidian.md/community-directory/submission-requirements-for-plugins
- Obsidian, Vault: https://docs.obsidian.md/Plugins/Vault
- Obsidian, SecretStorage guide: https://docs.obsidian.md/plugins/guides/secret-storage
- Obsidian, SecretStorage reference: https://docs.obsidian.md/Reference/TypeScript+API/SecretStorage
- Forum, mobile `requestUrl` large-file issue: https://forum.obsidian.md/t/bug-mobile-requesturl-has-performance-issue/84177
- Forum, background sync on mobile: https://forum.obsidian.md/t/make-obsidian-sync-work-in-background-on-mobile/25906
- Forum, SecretStorage shared across vaults on mobile: https://forum.obsidian.md/t/secretstorage-appears-to-be-shared-across-vaults-on-mobile-but-vault-scoped-on-desktop/117793
- Forum, BRAT release tags: https://forum.obsidian.md/t/cant-make-a-plugin-to-work-on-brat/84369
- Obsidian Git plugin page: https://community.obsidian.md/plugins/obsidian-git
- Vault Sync (REST): https://community.obsidian.md/plugins/vault-sync-rest
- Git Vault Sync: https://community.obsidian.md/plugins/git-vault-sync
- Hybrid Git Sync: https://community.obsidian.md/plugins/hybrid-git-sync
- GitHub, Git trees: https://docs.github.com/en/rest/git/trees
- GitHub, Using the REST API with your Git database: https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database
- GitHub, REST rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- GitHub, Authorizing OAuth apps (device flow): https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
