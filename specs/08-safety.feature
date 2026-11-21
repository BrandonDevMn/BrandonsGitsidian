@mvp @safety
Feature: Guard rails against data loss
  A sync tool that loses notes is worse than no sync tool.

  Background:
    Given BrandonGitsidian is connected and has completed its first sync

  Scenario: Never force-push
    When any push runs
    Then the branch ref is always updated with force set to false

  Scenario: Never delete a file sync has never seen
    Given "notes/brand new.md" exists in the vault but not in the sync index
    And it doesn't exist on GitHub
    When sync runs
    Then "notes/brand new.md" is uploaded, not deleted

  Scenario: Mass deletions need confirmation
    Given a sync would delete 25 or more files, or at least 5 files that are more than 10% of tracked files, on either side
    When sync runs
    Then nothing is deleted yet
    And I'm shown the list of files that would be deleted
    And I can choose "Delete them" or "Not now"
    And "Not now" deletes nothing and asks again on the next sync

  Scenario: A vault that looks wiped doesn't wipe GitHub
    Given the sync index lists 185 files
    And the vault now contains no tracked files at all
    When sync runs
    Then nothing is deleted on GitHub
    And I see "Your vault looks empty. Restore from GitHub, or confirm you meant to delete everything."

  Scenario: Local deletions from pulls go to the trash
    When a pull removes a file from the vault
    Then it is moved to the trash according to Obsidian's "Deleted files" setting

  Scenario: A sync interrupted halfway is safe to resume
    Given a pull wrote 10 of 20 changed files
    And iOS suspended Obsidian before the sync finished
    When the next sync runs
    Then the base commit is still the old one
    And the 10 written files match the remote by blob SHA and aren't treated as conflicts
    And the remaining 10 files are written

  Scenario: Big uploads are sent in batches that survive suspension
    Given I have 90 new notes to push
    When sync runs
    Then they are pushed as commits of at most 40 files, each labelled "part N of M"
    And progress is saved after each commit
    And if iOS suspends Obsidian between batches, the next sync sends only what's left, with no conflicts

  Scenario: The sync index is saved atomically
    When a sync finishes
    Then the new base commit and sync index are saved together in one write
    And if saving fails, the previous base and index are still intact

  Scenario: Dry run shows what would happen
    When I run the command "BrandonGitsidian: Preview sync"
    Then I see lists of files to pull, push, delete and conflicts
    And nothing is changed in the vault or on GitHub
