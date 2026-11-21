@mvp @safety
Feature: Handle conflicts without losing anything
  Brandon edits on his phone while Claude edits in the repo.
  Sometimes they'll touch the same note.

  Background:
    Given the vault is in sync with base commit "B1"
    And "games/overseers-of-oakhaven/timeline.md" was identical everywhere at "B1"

  Scenario: Edits to different parts of a Markdown note are merged
    Given I added a line under "## ooo s014" on the phone
    And Claude changed a line under "## ooo s003" in "B2"
    When sync runs
    Then BrandonGitsidian fetches the base version from GitHub by the blob SHA in the sync index
    And it does a three-way line merge of base, mine and GitHub's
    And the note contains both changes
    And the merged note is pushed as a commit on top of "B2"
    And I see "Merged your edits with GitHub's in timeline.md"

  Scenario: Edits to the same lines keep both versions
    Given I changed the "open questions" list on the phone
    And Claude changed the same lines in "B2"
    When sync runs
    Then "timeline.md" in the vault holds GitHub's version
    And my version is saved next to it as "timeline (conflict 261121-1405 Brandon's iPhone).md"
    And the conflict copy is pushed so Claude can see it too
    And I see a notice naming both files

  Scenario: Binary files are never merged
    Given both sides changed "players/chibi-sheet.jpeg"
    When sync runs
    Then GitHub's version keeps the original name
    And my version is saved as "chibi-sheet (conflict 261121-1405 Brandon's iPhone).jpeg"

  Scenario: Edited here, deleted there
    Given I edited "players/suri.md" on the phone
    And Claude deleted it in "B2"
    When sync runs
    Then "players/suri.md" stays in the vault with my edits
    And it is pushed back to GitHub
    And I see "players/suri.md was deleted on GitHub but you edited it, so it was kept"

  Scenario: Deleted here, edited there
    Given I deleted "players/noxen.md" on the phone
    And Claude edited it in "B2"
    When sync runs
    Then "players/noxen.md" is restored in the vault with Claude's edits
    And I see "players/noxen.md was edited on GitHub, so it was restored"

  Scenario: Both sides created the same new path
    Given I created "notes/ideas.md" with content X
    And Claude created "notes/ideas.md" with content Y in "B2"
    When sync runs
    Then "notes/ideas.md" holds content Y
    And content X is kept as "ideas (conflict 261121-1405 Brandon's iPhone).md"

  Scenario: Conflict copies are easy to find and clean up
    Given a sync produced 2 conflict copies
    When I run the command "BrandonGitsidian: Show conflicts"
    Then I see both conflict copies with the file each belongs to
    And I can open either one, or delete a copy once I've resolved it

  Scenario Outline: Conflict copy names
    Given a conflict on "<path>" at 2026-11-21 14:05 on "Brandon's iPhone"
    Then the conflict copy is named "<copy>"

    Examples:
      | path                          | copy                                                             |
      | timeline.md                   | timeline (conflict 261121-1405 Brandon's iPhone).md              |
      | characters/gary severus.md    | characters/gary severus (conflict 261121-1405 Brandon's iPhone).md |
      | players/chibi-sheet.jpeg      | players/chibi-sheet (conflict 261121-1405 Brandon's iPhone).jpeg |
