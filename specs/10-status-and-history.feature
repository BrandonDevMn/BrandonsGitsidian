@mvp
Feature: Show what sync is doing and what it did
  On an iPhone the status bar isn't shown, so status has to live
  somewhere visible on a small screen.

  Background:
    Given BrandonGitsidian is connected and has completed its first sync

  @ios
  Scenario Outline: The ribbon icon shows the sync state
    Given sync is <state>
    Then the BrandonGitsidian ribbon icon shows <icon>

    Examples:
      | state                     | icon                       |
      | idle and up to date       | a plain sync icon          |
      | running                   | a spinning sync icon       |
      | idle with unsynced edits  | a sync icon with a dot     |
      | stopped by an error       | a warning icon             |
      | paused                    | a paused icon              |

  Scenario: Quiet when nothing happened
    When a sync finds nothing to pull or push
    Then no notice is shown

  Scenario: A short summary when something changed
    When a sync pulls 3 files and pushes 1
    Then I see a notice "Synced: 3 from GitHub, 1 to GitHub"
    And tapping the notice opens the sync log

  Scenario: The sync log
    When I run the command "BrandonGitsidian: Open sync log"
    Then I see the last 50 syncs, newest first
    And each entry shows the time, the trigger, files pulled, pushed and conflicted, and any errors
    And each changed path can be tapped to open the note

  Scenario: What changed on GitHub is readable
    Given Claude pushed 2 commits since my last sync
    When the sync pulls them
    Then the sync log shows each commit's message and author
    And the files each commit changed

  Scenario: Settings show the current state
    When I open the BrandonGitsidian settings tab
    Then I see the last successful sync time
    And the short SHA of the base commit with a link to it on GitHub
    And the number of tracked files

  Scenario: A detailed log I can read in the app
    When I run the command "BrandonGitsidian: Open detailed log"
    Then a log view opens inside Obsidian, readable on an iPhone screen
    And it lists every step of recent syncs, newest first, with a timestamp and level
    And steps include the trigger, each GitHub request with method, path, status and time taken
    And each file read, written, trashed, merged or skipped, with the reason
    And every decision from change classification, and every error with its full message
    And I can filter by level: errors, info, or everything

  Scenario: The detailed log survives restarts but stays small
    Given iOS closed Obsidian since the last sync
    When I open the detailed log
    Then entries from before the restart are still there
    And only the newest 2,000 entries are kept

  @safety
  Scenario: The detailed log never contains secrets
    When any request is logged
    Then the Authorization header and token are never written to the log
    And file contents are never written to the detailed log

  Scenario: Share the detailed log
    When I tap "Copy log" in the log view
    Then the log text is copied so I can paste it to Claude
    And "Save log to note" writes it to "_brandon-gitsidian/detailed log.md"

  Scenario: Errors are shown once, not every 5 minutes
    Given automatic syncs keep failing for the same reason
    Then I see the error notice the first time
    And later failures for the same reason only update the ribbon icon and the log
