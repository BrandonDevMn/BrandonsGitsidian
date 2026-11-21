@mvp
Feature: Show what sync is doing and what it did
  On an iPhone the status bar isn't shown, so status has to live
  somewhere visible on a small screen.

  Background:
    Given Gitsidian is connected and has completed its first sync

  @ios
  Scenario Outline: The ribbon icon shows the sync state
    Given sync is <state>
    Then the Gitsidian ribbon icon shows <icon>

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
    When I run the command "Gitsidian: Open sync log"
    Then I see the last 50 syncs, newest first
    And each entry shows the time, the trigger, files pulled, pushed and conflicted, and any errors
    And each changed path can be tapped to open the note

  Scenario: What changed on GitHub is readable
    Given Claude pushed 2 commits since my last sync
    When the sync pulls them
    Then the sync log shows each commit's message and author
    And the files each commit changed

  Scenario: Settings show the current state
    When I open the Gitsidian settings tab
    Then I see the last successful sync time
    And the short SHA of the base commit with a link to it on GitHub
    And the number of tracked files

  Scenario: Errors are shown once, not every 5 minutes
    Given automatic syncs keep failing for the same reason
    Then I see the error notice the first time
    And later failures for the same reason only update the ribbon icon and the log
