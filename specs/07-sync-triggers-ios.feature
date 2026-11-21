@mvp @ios
Feature: When sync runs on iOS
  iOS suspends Obsidian soon after it leaves the screen and gives plugins
  no real background time, so sync has to happen while the app is open.

  Background:
    Given BrandonGitsidian is connected and has completed its first sync

  Scenario: Sync when Obsidian opens
    Given "Sync on startup" is on
    When Obsidian finishes loading the vault layout
    Then a sync starts
    And vault file events from the initial load are not treated as edits

  Scenario: Sync when coming back to Obsidian
    Given "Sync when app returns" is on
    And Obsidian was in the background for at least 30 seconds
    When I switch back to Obsidian
    Then a sync starts

  Scenario: Sync on a timer while Obsidian is open
    Given the sync interval is 5 minutes
    And Obsidian stays in the foreground
    Then a sync runs every 5 minutes
    And the timer pauses while Obsidian is in the background

  Scenario: Push soon after I stop typing
    Given "Push after edits" is on with a delay of 20 seconds
    When I edit "games/overseers-of-oakhaven/sessions/ooo s014.md"
    And I stop typing for 20 seconds
    Then a sync starts
    And further edits within the 20 seconds restart the countdown

  Scenario: Quick push when leaving the app
    Given I have unsynced edits
    When I switch away from Obsidian
    Then BrandonGitsidian immediately tries to push only the changed files
    And it doesn't start downloads
    But if iOS suspends the app first, the edits are pushed on the next sync instead

  Scenario Outline: Sync on demand
    When I <action>
    Then a sync starts right away, even if the timer isn't due

    Examples:
      | action                                  |
      | tap the BrandonGitsidian ribbon icon           |
      | run the command "BrandonGitsidian: Sync now"   |

  Scenario: Sync from an iOS Shortcut
    When an iOS Shortcut opens the URL "obsidian://brandon-gitsidian?action=sync"
    Then Obsidian opens and a sync starts

  Scenario: Only one sync at a time
    Given a sync is already running
    When another trigger fires
    Then the second sync is queued to run once after the current one finishes
    And no two syncs ever write to the vault at the same time

  Scenario: Sync waits for the network
    Given the device is offline
    When a timer or edit trigger fires
    Then no request is made
    And the sync runs the next time a trigger fires while online

  Scenario: Pause syncing
    When I run the command "BrandonGitsidian: Pause sync"
    Then no automatic syncs run until I resume
    And "Sync now" still works
