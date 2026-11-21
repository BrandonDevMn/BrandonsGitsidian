@mvp
Feature: Push vault changes to GitHub
  Edits made on the phone become a normal git commit on the branch,
  built with the GitHub Git Database API (no git binary needed).

  Background:
    Given the vault is in sync with base commit "B1"
    And the remote head is still "B1"

  Scenario: Edited notes are pushed as one commit
    Given I edited "games/overseers-of-oakhaven/timeline.md"
    And I created "games/overseers-of-oakhaven/characters/wren stonehill.md"
    When sync runs
    Then one blob is created for each changed or new file
    And one tree is created on top of the head's tree using base_tree
    And one commit is created with "B1" as its only parent
    And the "main" branch ref is moved to the new commit without force
    And the base commit and sync index are updated

  Scenario: The commit message says what changed and where
    Given I edited 2 notes and added 1 on a device named "Brandon's iPhone"
    When sync runs
    Then the commit message's first line is "BrandonGitsidian: 3 notes from Brandon's iPhone"
    And the message body lists each path with "updated", "added" or "deleted"

  Scenario: Deletions are pushed as tree entries with no blob
    Given I deleted "games/overseers-of-oakhaven/characters/old idea.md"
    When sync runs
    Then the new tree marks that path with a null SHA
    And the file no longer exists on "main" after the push

  Scenario: Deleting a path GitHub no longer has is skipped
    Given I deleted "notes/scratch.md" locally
    And it was already deleted on GitHub
    When sync runs
    Then no tree entry is sent for "notes/scratch.md"
    And the push still succeeds

  @safety
  Scenario: Someone pushed in the meantime
    Given I edited "games/overseers-of-oakhaven/quests.md"
    And while my push was being built, Claude pushed "B2" to "main"
    When BrandonGitsidian tries to move "main" to its new commit
    Then GitHub rejects the update because it isn't a fast-forward
    And BrandonGitsidian does not force the update
    And it pulls "B2", reclassifies changes, and rebuilds the commit on top of "B2"
    And it retries at most 3 times before reporting "GitHub kept changing. Try again in a minute."

  Scenario: Binary files are uploaded base64-encoded
    Given I added "games/overseers-of-oakhaven/players/chibi-sheet.jpeg"
    When sync runs
    Then its blob is created with encoding "base64"
    And the blob SHA GitHub returns equals the SHA BrandonGitsidian computed locally

  Scenario: Nothing to push means no commit
    Given there are no local changes
    When sync runs
    Then no blob, tree or commit is created

  Scenario: Pushing to an empty repository
    Given the repository has no commits
    When sync pushes for the first time
    Then the first file is created with the contents API to initialise the repo
    And the remaining files are added with the Git Database API
