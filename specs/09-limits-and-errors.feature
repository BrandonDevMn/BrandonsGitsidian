@mvp
Feature: Limits and errors
  Phones go offline, GitHub has rate limits, and mobile requestUrl
  has trouble with very large bodies.

  Background:
    Given BrandonGitsidian is connected and has completed its first sync

  @ios
  Scenario: Very large files are skipped with a warning
    Given the maximum file size is 20 MB
    And I added "games/overseers-of-oakhaven/maps/world.png" which is 35 MB
    When sync runs
    Then the file is not uploaded
    And I see "Skipped world.png (35 MB). Files over 20 MB aren't synced on iPhone."
    And the rest of the sync completes

  Scenario: Approaching the rate limit
    Given GitHub reports 40 requests remaining this hour
    And the sync needs 120 requests
    When sync runs
    Then BrandonGitsidian syncs as many whole files as it safely can
    And stops before the limit, keeping the sync resumable
    And I see when the limit resets

  Scenario: Secondary rate limit
    Given GitHub responds with HTTP 403 or 429 and a "retry-after" header of 60 seconds
    When sync is uploading blobs
    Then BrandonGitsidian waits 60 seconds before the next request
    And it never sends more than 60 blob uploads per minute

  Scenario: Going offline mid-sync
    Given the device loses its connection halfway through a pull
    When the next request fails with a network error
    Then the sync stops without changing the base commit
    And I see "Lost connection. Will finish next time."

  Scenario: Expired token
    Given the token has expired
    When sync runs
    Then sync stops before changing anything
    And I see "GitHub token expired. Update it in BrandonGitsidian settings."
    And automatic syncs pause until the token is fixed

  Scenario: Branch was deleted or rewritten on GitHub
    Given the base commit "B1" is no longer an ancestor of the remote head
    When sync runs
    Then BrandonGitsidian doesn't pull or push automatically
    And I see "GitHub's history changed. Choose how to re-sync." with the first-sync choices

  Scenario: Paths GitHub or iOS can't store
    Given a note's path contains a character that isn't valid on iOS, such as ":"
    When that file arrives from GitHub
    Then it's skipped with a warning naming the file
    And it isn't deleted on GitHub

  Scenario: Case-only renames
    Given Claude renamed "Tresendar Manor.md" to "tresendar manor.md" on GitHub
    When sync runs
    Then the vault ends up with exactly one file, named "tresendar manor.md"
