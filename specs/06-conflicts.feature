@mvp @safety
Feature: Handle conflicts: GitHub wins, and it's logged
  Brandon edits on his phone while Claude edits in the repo.
  When both change the same thing, GitHub's version (Claude's) wins outright.
  The phone's version is discarded, but recorded in the conflict log
  so nothing vanishes without a trace.

  Background:
    Given the vault is in sync with base commit "B1"
    And "games/overseers-of-oakhaven/timeline.md" was identical everywhere at "B1"
    And the device name is "Brandon's iPhone"

  Scenario: Edits to different parts of a Markdown note are merged, not a conflict
    Given I added a line under "## ooo s014" on the phone
    And Claude changed a line under "## ooo s003" in "B2"
    When sync runs
    Then BrandonGitsidian fetches the base version from GitHub by the blob SHA in the sync index
    And it does a three-way line merge of base, mine and GitHub's
    And the note contains both changes
    And the merged note is pushed as a commit on top of "B2"
    And nothing is written to the conflict log

  Scenario: Edits to the same lines: GitHub's version wins
    Given I changed the "open questions" list on the phone
    And Claude changed the same lines in "B2"
    When sync runs
    Then "timeline.md" in the vault holds GitHub's version
    And my version is not kept as a file anywhere in the vault
    And no conflict copy is created
    And an entry is added to the conflict log
    And I see "Conflict in timeline.md: kept GitHub's version. See the conflict log."

  Scenario: Binary files: GitHub's version wins
    Given both sides changed "players/chibi-sheet.jpeg"
    When sync runs
    Then the vault holds GitHub's version of "players/chibi-sheet.jpeg"
    And the conflict log records that my version was discarded, without its bytes

  Scenario: Edited here, deleted there: the deletion wins
    Given I edited "players/suri.md" on the phone
    And Claude deleted it in "B2"
    When sync runs
    Then "players/suri.md" is moved to the trash
    And it is not pushed back to GitHub
    And the conflict log records my discarded edits

  Scenario: Deleted here, edited there: GitHub's edit wins
    Given I deleted "players/noxen.md" on the phone
    And Claude edited it in "B2"
    When sync runs
    Then "players/noxen.md" is restored in the vault with Claude's edits
    And the conflict log records that my deletion was undone

  Scenario: Both sides created the same new path: GitHub's wins
    Given I created "notes/ideas.md" with content X
    And Claude created "notes/ideas.md" with content Y in "B2"
    When sync runs
    Then "notes/ideas.md" holds content Y
    And the conflict log records content X as discarded

  Scenario: What a conflict log entry contains
    When a conflict is resolved in GitHub's favour at 2026-11-21 14:05
    Then the entry is appended to "_brandon-gitsidian/conflict log.md"
    And it shows the time, the device, the file path as a link, and what happened
    And for text files it includes my discarded version inside a collapsed callout
    And for binary files it includes only the file size

  Scenario: The conflict log is synced like any note
    Given an entry was added to "_brandon-gitsidian/conflict log.md"
    When the sync's push runs
    Then the conflict log is pushed to GitHub
    And Claude can read it to see what was overwritten

  Scenario: The conflict log stays a manageable size
    Given the conflict log has more than 100 entries
    When a new entry is added
    Then the oldest entries beyond the newest 100 are removed
