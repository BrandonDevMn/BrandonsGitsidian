# Specs

Gherkin feature files that define how BrandonGitsidian behaves. They are the source of truth: if code and spec disagree, the spec wins until it's deliberately changed.

## Files

| File | Covers |
| --- | --- |
| [`01-setup-and-auth.feature`](01-setup-and-auth.feature) | Connecting a repo, storing the token, checking access |
| [`02-first-sync.feature`](02-first-sync.feature) | The very first sync: empty repo, empty vault, or both full |
| [`03-change-detection.feature`](03-change-detection.feature) | Working out what changed locally and on GitHub |
| [`04-pull.feature`](04-pull.feature) | Bringing GitHub changes into the vault |
| [`05-push.feature`](05-push.feature) | Sending vault changes to GitHub as a commit |
| [`06-conflicts.feature`](06-conflicts.feature) | Both sides changed the same file |
| [`07-sync-triggers-ios.feature`](07-sync-triggers-ios.feature) | When sync runs, given how iOS suspends apps |
| [`08-safety.feature`](08-safety.feature) | Guard rails against data loss |
| [`09-limits-and-errors.feature`](09-limits-and-errors.feature) | Big files, rate limits, offline, API errors |
| [`10-status-and-history.feature`](10-status-and-history.feature) | Telling the user what happened |
| [`11-ai-collaboration.feature`](11-ai-collaboration.feature) | Working alongside Claude editing the same repo |
| [`12-ios-platform.feature`](12-ios-platform.feature) | Platform rules the code must follow on iOS |

Background research and sources: [`research.md`](research.md).

## Tags

- `@mvp`: required for the first usable release.
- `@later`: specified, but deferred.
- `@ios`: behaviour specific to (or driven by) iOS.
- `@safety`: protects against data loss. Never cut these.

## Glossary

- **Vault**: the Obsidian folder on the device.
- **Remote**: the GitHub repository and branch being synced.
- **Head**: the commit the remote branch points to right now.
- **Base**: the commit the vault was last in sync with. Stored by the plugin.
- **Sync index**: per file, the git blob SHA recorded at the last successful sync. Used to tell "changed here" from "changed there".
- **Blob SHA**: git's SHA-1 of `"blob <size>\0" + bytes`. Computed locally so the plugin can compare files with GitHub without downloading them.
- **Tracked file**: a file that is synced. Excluded paths (see setup) are never tracked.
- **Conflict copy**: a second file holding the other side's version, created instead of overwriting.

## Writing style

- One capability per file; one behaviour per scenario.
- Use concrete paths from a real vault (`games/overseers-of-oakhaven/...`) so scenarios read like real use.
- Describe what the user sees and what lands on GitHub, not internal function names.
