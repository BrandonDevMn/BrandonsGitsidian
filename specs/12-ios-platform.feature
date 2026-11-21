@mvp @ios
Feature: iOS platform rules
  Rules the implementation must follow so the plugin loads and runs on Obsidian for iOS.
  These are checked by build-time linting and by running the plugin on an iPhone.

  Scenario: The manifest identifies a personal plugin
    Then manifest.json has "id" set to "brandon-gitsidian"
    And "name" set to "BrandonGitsidian"
    And the description says it's a personal plugin for Brandon's vault

  Scenario: The plugin can be installed on mobile
    Then manifest.json has "isDesktopOnly" set to false
    And "minAppVersion" is at least "1.11.4" so SecretStorage is available

  Scenario: No Node.js or Electron APIs
    When the plugin bundle is built
    Then it doesn't import "fs", "path", "os", "crypto", "child_process" or "electron"
    And no dependency does either

  Scenario: All HTTP goes through requestUrl
    When the plugin talks to GitHub
    Then every request uses Obsidian's requestUrl
    And none use fetch, XMLHttpRequest or axios

  Scenario: Hashing uses Web Crypto
    When the plugin computes a git blob SHA
    Then it uses crypto.subtle.digest with "SHA-1"

  Scenario: No regex lookbehind
    When the source and bundle are linted
    Then no regular expression uses lookbehind, because iOS before 16.4 can't run it

  Scenario: The vault adapter is never assumed to be a desktop file system
    When the plugin reads or writes files
    Then it uses the Vault API for vault-visible files
    And it never casts the adapter to FileSystemAdapter

  Scenario: Platform checks use Obsidian's Platform
    When the plugin needs to know it's on iOS
    Then it checks Platform.isIosApp
    And it never reads process.platform

  Scenario: Memory stays bounded
    When the plugin syncs a vault of any size
    Then it holds at most one file's contents in memory at a time, plus the file list
    And it never downloads an archive or a git packfile

  Scenario: Release is installable through BRAT
    When a version is released
    Then the GitHub release tag equals manifest.json's "version" exactly, with no "v" prefix
    And the release has "main.js" and "manifest.json" attached
