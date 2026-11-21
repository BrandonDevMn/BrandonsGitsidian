@mvp
Feature: Detailed log
  A full technical log of what BrandonGitsidian does, readable inside Obsidian on an iPhone,
  so Brandon (or Claude) can see exactly what happened and why.

  Background:
    Given BrandonGitsidian is enabled

  # ---- What gets logged -----------------------------------------------------

  Scenario: Every sync is a labelled run
    When a sync starts
    Then the log records a "sync started" entry with a run number and the trigger
    And every entry written during that sync carries the same run number
    And a "sync finished" entry records the outcome and counts of pulled, pushed, trashed, merged, conflicted and skipped files
    And the total time the sync took

  Scenario: GitHub requests are logged
    When the plugin makes a request to GitHub
    Then the log records the method, the API path, the HTTP status and the time taken in milliseconds
    And the number of API requests left this hour

  Scenario: File operations are logged with reasons
    When sync hashes, reads, writes, trashes, merges or skips a file
    Then the log records the path and what happened
    And skipped files include the reason, such as "over the 20 MB limit" or "name isn't valid on iOS"

  Scenario: Decisions are logged
    When sync classifies changes
    Then each changed path is logged with its classification, such as "push update" or "conflict"
    And each conflict records which side won and that it was added to the conflict log

  Scenario: Errors are logged in full
    When something goes wrong
    Then an error entry records what failed, the error type and GitHub's message
    And unexpected internal errors include a stack trace

  Scenario: Lifecycle events are logged
    When the plugin loads, unloads, Obsidian goes to the background or comes back, or settings change
    Then each event is logged at info level
    And settings changes record which setting changed, but never a secret's value

  # ---- Levels -----------------------------------------------------------------

  Scenario Outline: Levels
    Then "<level>" entries are used for <meaning>

    Examples:
      | level | meaning                                                       |
      | error | failures that stopped a sync or an action                      |
      | warn  | something skipped, retried, overwritten or worth a look        |
      | info  | the story of each sync: start, pulled/pushed files, finish     |
      | debug | every request, hash and classification                          |

  Scenario: Debug logging can be turned down
    Given "Log debug details" is off in settings
    Then debug entries are not recorded
    And error, warn and info entries still are

  # ---- Viewing ----------------------------------------------------------------

  Scenario: Open the log in the app
    When I run the command "BrandonGitsidian: Open detailed log"
    Then a log view opens as a tab inside Obsidian, readable on an iPhone screen
    And it shows entries newest first with time, level and message
    And errors and warnings stand out by colour

  Scenario: Filter by level
    Given the log view is open
    When I choose "Errors", "Warnings", "Info" or "Everything"
    Then only entries at that level or more serious are shown

  Scenario: Search the log
    Given the log view is open
    When I type "timeline.md" into the search box
    Then only entries whose message contains "timeline.md" are shown

  Scenario: Show one sync at a time
    Given the log view is open
    When I tap a sync's run number
    Then only that sync's entries are shown, oldest first, so it reads like a story
    And a "Show all" button returns to the full log

  Scenario: The log updates live
    Given the log view is open
    When a sync runs
    Then new entries appear without reopening the view

  Scenario: The log is one tap from settings
    When I tap "Open detailed log" in the BrandonGitsidian settings tab
    Then the detailed log opens

  # ---- Keeping and sharing -----------------------------------------------------

  Scenario: The log survives restarts
    Given iOS closed Obsidian since the last sync
    When I open the detailed log
    Then entries from before the restart are still there

  Scenario: The log stays small
    When more than 2,000 entries have been written
    Then only the newest 2,000 are kept

  Scenario: The log is saved without slowing sync down
    When entries are written during a sync
    Then they are saved to plugin storage at most every few seconds and when the sync finishes
    And when Obsidian goes to the background

  Scenario: Copy the log
    When I tap "Copy" in the log view
    Then the entries currently shown are copied as plain text
    And the copy starts with the plugin version, Obsidian version, platform and repo name

  Scenario: Save the log to a note
    When I tap "Save to note" in the log view
    Then the entries currently shown are written to "_brandon-gitsidian/detailed log.md"
    And that note is synced like any other, so Claude can read it

  Scenario: Clear the log
    When I tap "Clear" in the log view and confirm
    Then all entries are removed
    And a single entry records that the log was cleared

  # ---- Privacy ------------------------------------------------------------------

  @safety
  Scenario: The log never contains secrets or note contents
    When anything is logged
    Then GitHub tokens and Authorization headers are replaced with "[redacted]"
    And note contents are never written to the log, only paths and sizes
