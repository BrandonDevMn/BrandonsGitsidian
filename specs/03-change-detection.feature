@mvp
Feature: Work out what changed since the last sync
  Each sync compares three snapshots for every tracked path:
  the base (sync index), the vault now, and the remote head now.

  Background:
    Given the vault was last synced at base commit "B1"
    And the sync index records a blob SHA for every tracked file at "B1"

  Scenario Outline: Classify each path
    Given the path "<path>" was "<at base>" at the base
    And it is "<in vault>" in the vault
    And it is "<on GitHub>" on GitHub
    When sync classifies changes
    Then the path is classified as "<result>"

    Examples:
      | path                       | at base  | in vault  | on GitHub | result               |
      | quests.md                  | A        | A         | A         | unchanged            |
      | timeline.md                | A        | A2        | A         | push update          |
      | characters/voki.md         | A        | A         | A2        | pull update          |
      | characters/wren.md         | missing  | new       | missing   | push new file        |
      | locations/weeping hollow.md| missing  | missing   | new       | pull new file        |
      | characters/old.md          | A        | deleted   | A         | push deletion        |
      | sessions/ooo s014.md       | A        | A         | deleted   | pull deletion        |
      | players/esa.md             | A        | A2        | A3        | conflict             |
      | players/kuy.md             | A        | A2        | A2        | already the same     |
      | notes/draft.md             | missing  | new X     | new Y     | conflict             |
      | notes/same.md              | missing  | new X     | new X     | already the same     |
      | players/suri.md            | A        | A2        | deleted   | conflict             |
      | players/noxen.md           | A        | deleted   | A2        | conflict             |
      | players/syfer.md           | A        | deleted   | deleted   | already the same     |

  Scenario: Local changes are detected by content, not timestamps
    Given "games/overseers-of-oakhaven/timeline.md" was saved but its bytes didn't change
    When sync classifies changes
    Then the file is "unchanged"

  Scenario: Blob SHAs are computed the same way git does
    Given a local file whose bytes are "hello\n"
    When Gitsidian computes its blob SHA
    Then the SHA is "ce013625030ba8dba906f756967f9e9ca394464a"

  Scenario: Unchanged files aren't re-hashed every sync
    Given a file's size and modified time match what the sync index recorded
    When sync classifies changes
    Then the file is treated as unchanged without reading its bytes

  Scenario: The remote side is read cheaply
    When sync checks GitHub for changes
    Then it reads the branch ref first
    And if the head is still "B1" it skips reading the tree
    And otherwise it reads the head's tree recursively and compares blob SHAs to the index

  Scenario: A truncated remote tree is walked in pieces
    Given GitHub returns the recursive tree with "truncated" set to true
    When sync checks GitHub for changes
    Then it fetches each subtree without the recursive option
    And it ends up with the complete list of remote files

  Scenario: Renames are handled as delete plus add
    Given I renamed "characters/severus glass-staff.md" to "characters/gary severus.md" in Obsidian
    When sync classifies changes
    Then "characters/severus glass-staff.md" is a "push deletion"
    And "characters/gary severus.md" is a "push new file"
    And both go into the same commit, so GitHub shows a rename
