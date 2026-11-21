Feature: Work alongside Claude in the same repository
  Claude edits the vault repo with real git from the cloud while Brandon uses the phone.
  These scenarios make that hand-off smooth.

  Background:
    Given Gitsidian syncs "BrandonDevMn/Claudian"
    And Claude works on the same repository using git

  @mvp
  Scenario: Hand-off before talking to Claude
    Given I edited notes on my phone
    When I run "Gitsidian: Sync now" before starting a conversation with Claude
    Then my edits are on GitHub
    And Claude sees them when it pulls

  @mvp
  Scenario: Seeing Claude's work after a conversation
    Given Claude pushed changes during our conversation
    When I switch back to Obsidian
    Then the changes are pulled automatically
    And the notice says how many files came from GitHub

  @mvp
  Scenario: Commits from the phone are recognisable
    When Gitsidian pushes a commit
    Then the commit message starts with "Gitsidian:"
    And it names the device it came from
    And Claude can tell phone edits from its own in the git log

  @mvp
  Scenario: Conflict copies are visible to Claude
    Given a sync created "timeline (conflict 261121-1405 Brandon's iPhone).md"
    Then that file is pushed to GitHub
    And Claude can merge it and delete the copy in a later commit
    And that deletion is pulled back to the phone like any other change

  @mvp
  Scenario: Claude's memory folder syncs like any other folder
    Given the repo contains "_ai-context/file-rules.md"
    When sync runs
    Then "_ai-context/" is synced in both directions
    And it isn't treated as hidden or excluded

  @later
  Scenario: Remind me when I'm about to talk to Claude with unsynced edits
    Given I have edits that haven't been pushed
    When I open the Claude app from an iOS Shortcut that first runs "obsidian://gitsidian?action=sync"
    Then the sync finishes before the Claude app opens

  @later
  Scenario: Quick "what did Claude change?" view
    When I run the command "Gitsidian: What changed since I last looked"
    Then I see a list of notes changed by commits not made by Gitsidian
    And each item opens the note with the changed lines highlighted
