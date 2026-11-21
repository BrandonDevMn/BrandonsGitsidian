Feature: Work alongside Claude in the same repository
  Claude edits the vault repo with real git from the cloud while Brandon uses the phone.
  These scenarios make that hand-off smooth.

  Background:
    Given BrandonGitsidian syncs "BrandonDevMn/Claudian"
    And Claude works on the same repository using git

  @mvp
  Scenario: Hand-off before talking to Claude
    Given I edited notes on my phone
    When I run "BrandonGitsidian: Sync now" before starting a conversation with Claude
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
    When BrandonGitsidian pushes a commit
    Then the commit message starts with "BrandonGitsidian:"
    And it names the device it came from
    And Claude can tell phone edits from its own in the git log

  @mvp
  Scenario: Claude can see what a conflict overwrote
    Given a sync discarded my phone edits to "timeline.md" in GitHub's favour
    Then the entry in "_brandon-gitsidian/conflict log.md" is pushed to GitHub
    And Claude can read my discarded text there and fold it back in if it matters

  @mvp
  Scenario: Claude's memory folder syncs like any other folder
    Given the repo contains "_ai-context/file-rules.md"
    When sync runs
    Then "_ai-context/" is synced in both directions
    And it isn't treated as hidden or excluded

  @later
  Scenario: Remind me when I'm about to talk to Claude with unsynced edits
    Given I have edits that haven't been pushed
    When I open the Claude app from an iOS Shortcut that first runs "obsidian://brandon-gitsidian?action=sync"
    Then the sync finishes before the Claude app opens

  @later
  Scenario: Quick "what did Claude change?" view
    When I run the command "BrandonGitsidian: What changed since I last looked"
    Then I see a list of notes changed by commits not made by BrandonGitsidian
    And each item opens the note with the changed lines highlighted
