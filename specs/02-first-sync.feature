@mvp
Feature: First sync
  The first sync has no shared history to compare against,
  so it has to decide how a vault and a repo come together without losing anything.

  Background:
    Given Gitsidian is connected to "BrandonDevMn/Claudian" on branch "main"
    And no base commit is stored yet

  Scenario: Empty vault, repo has notes (fresh phone)
    Given the vault is empty
    And the repo contains 185 tracked files
    When the first sync runs
    Then all 185 files are downloaded into the vault with the same folder structure
    And file contents match the repo byte for byte
    And the base commit is set to the repo head
    And the sync index records every file's blob SHA

  Scenario: Vault has notes, repo is completely empty
    Given the vault contains 40 notes
    And the repository has no commits at all
    When the first sync runs
    Then the repository is initialised with one file through the contents API
    And the remaining notes are pushed as a single commit on top of it
    And the commit message is "Gitsidian: initial upload from iPhone"
    And the base commit is set to the new head

  @safety
  Scenario: Both sides have notes
    Given the vault contains "games/overseers-of-oakhaven/timeline.md"
    And the repo also contains "games/overseers-of-oakhaven/timeline.md"
    When I start the first sync
    Then I'm asked to choose how to combine them:
      | choice               | effect                                                                 |
      | Use GitHub's version | Download everything; local files that differ are kept as conflict copies |
      | Use this vault       | Upload everything; GitHub files that differ are kept as conflict copies |
      | Merge both           | Identical files are linked; different ones become conflict copies     |
    And nothing is changed until I choose

  Scenario: Identical files are recognised without downloading them
    Given the vault and the repo both contain "_ai-context/README.md" with identical bytes
    When the first sync runs with "Merge both"
    Then the file's local blob SHA equals the remote blob SHA
    And the file is recorded as in sync without being downloaded or uploaded

  Scenario: Excluded paths are left alone on first sync
    Given the repo contains ".obsidian/app.json"
    And ".obsidian/" is excluded
    When the first sync runs
    Then ".obsidian/app.json" is not downloaded
    And the vault's own ".obsidian/" folder is not uploaded

  Scenario: A first sync that is interrupted can resume
    Given the first sync downloaded 90 of 185 files
    And Obsidian was then suspended by iOS
    When I reopen Obsidian and sync runs again
    Then the 90 downloaded files are recognised by blob SHA and not downloaded again
    And the remaining 95 files are downloaded
