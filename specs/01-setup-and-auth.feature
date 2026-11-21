@mvp
Feature: Connect a vault to a GitHub repository
  As Brandon on his iPhone
  I want to point BrandonGitsidian at one GitHub repo with a token
  So that my vault can sync with the repo Claude edits

  Background:
    Given Obsidian for iOS is running a vault named "Claudian"
    And the BrandonGitsidian plugin is enabled

  Scenario: Settings ask only for what's needed
    When I open the BrandonGitsidian settings tab
    Then I see fields for repository owner, repository name and branch
    And I see a token picker backed by Obsidian's SecretStorage
    And the branch defaults to "main"
    And I see a "Test connection" button

  @safety
  Scenario: The token is stored in SecretStorage, not in plugin data
    When I pick or create the secret "github-claudian" in the token picker
    And I paste a fine-grained personal access token into it
    Then the token is saved with SecretStorage under the ID "github-claudian"
    And the plugin's data.json contains the secret ID "github-claudian"
    But the plugin's data.json does not contain the token itself

  Scenario: Test connection succeeds
    Given owner "BrandonDevMn", repository "Claudian" and branch "main" are set
    And the token can read and write contents of that repository
    When I tap "Test connection"
    Then I see "Connected to BrandonDevMn/Claudian (main)"
    And the notice shows how many API requests are left this hour

  Scenario Outline: Test connection explains what's wrong
    Given owner "BrandonDevMn", repository "Claudian" and branch "main" are set
    And <problem>
    When I tap "Test connection"
    Then I see the message "<message>"
    And no files are changed in the vault or on GitHub

    Examples:
      | problem                                         | message                                                                  |
      | no token has been chosen                        | Pick a GitHub token in settings first.                                   |
      | GitHub rejects the token as invalid or expired  | GitHub didn't accept this token. Create a new one and try again.         |
      | the token can read but not write contents       | This token is read-only. Give it "Contents: Read and write" access.      |
      | the repository doesn't exist or isn't visible   | Can't see BrandonDevMn/Claudian. Check the name and the token's repo access. |
      | the branch "main" doesn't exist                 | Branch "main" not found. Pick an existing branch or leave the repo empty. |
      | the device is offline                           | You're offline. Try again when you're connected.                         |

  Scenario: Setup guidance recommends a narrowly scoped token
    When I tap "How do I make a token?"
    Then I'm shown steps to create a fine-grained personal access token
    And the steps say to give it access to only this one repository
    And the steps say to grant "Contents: Read and write" and nothing else
    And the steps suggest an expiry date

  Scenario: Default exclusions are shown and editable
    When I open the BrandonGitsidian settings tab
    Then the excluded paths list contains ".obsidian/", ".trash/" and ".git/"
    And I can add patterns such as "*.tmp" or "private/**"
    And excluded files are never uploaded, downloaded or deleted by sync

  Scenario: Changing the repository requires a fresh first sync
    Given the vault has synced with "BrandonDevMn/Claudian"
    When I change the repository name to "Other-Vault"
    Then I'm warned that the next sync will be treated as a first sync
    And the stored base commit and sync index are cleared only after I confirm

  @later
  Scenario: Sign in with GitHub using the device flow
    When I tap "Sign in with GitHub"
    Then I'm shown a short code and a button that opens github.com/login/device
    And after I approve in Safari and return to Obsidian
    Then the resulting token is saved in SecretStorage
    And I never have to copy and paste a token
