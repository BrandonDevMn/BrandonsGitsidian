@mvp
Feature: Pull changes from GitHub into the vault
  When Claude (or anyone) pushes to the repo, those changes
  should appear in Obsidian on the phone.

  Background:
    Given the vault is in sync with base commit "B1"
    And Claude has since pushed commit "B2" to "main"

  Scenario: A note Claude edited is updated in the vault
    Given "B2" changes "games/overseers-of-oakhaven/characters/voki.md"
    And I haven't edited that note on the phone
    When sync runs
    Then the note's contents in the vault match "B2"
    And the note is written through the Vault API so open editors and links refresh
    And the sync index and base commit are updated to "B2"

  Scenario: A note Claude created appears in the right folder
    Given "B2" adds "games/overseers-of-oakhaven/characters/wren stonehill.md"
    When sync runs
    Then the file exists in the vault at that path
    And any missing parent folders are created

  @safety
  Scenario: A note Claude deleted goes to the trash, not oblivion
    Given "B2" deletes "games/overseers-of-oakhaven/sessions/ooo s011.md"
    And I haven't edited that note on the phone
    When sync runs
    Then the note is moved to the trash using Obsidian's trash setting
    And it can be restored from the trash

  Scenario: Binary files are written as binary
    Given "B2" adds "games/overseers-of-oakhaven/players/chibi-sheet.jpeg"
    When sync runs
    Then the image is written with the binary write API
    And its bytes match the blob on GitHub exactly

  Scenario: Files are downloaded one at a time
    Given "B2" changes 60 files
    When sync runs
    Then each changed blob is downloaded and written before the next is requested
    And peak memory use stays near the size of the largest single file

  Scenario: Only changed files are downloaded
    Given "B2" changes 2 files out of 185
    When sync runs
    Then exactly 2 blobs are downloaded

  Scenario: Pulling an excluded path does nothing
    Given "B2" changes ".obsidian/core-plugins.json"
    And ".obsidian/" is excluded
    When sync runs
    Then the vault's ".obsidian/core-plugins.json" is untouched

  Scenario: A file open in the editor is updated safely
    Given "games/overseers-of-oakhaven/timeline.md" is open in the editor
    And I have no unsaved or unsynced changes to it
    And "B2" changes it
    When sync runs
    Then the editor shows the new content
    And my cursor stays in the note

  Scenario: Several commits since the last sync are applied as one
    Given Claude pushed "B2", "B3" and "B4" since "B1"
    When sync runs
    Then the vault matches "B4"
    And the base commit becomes "B4"
