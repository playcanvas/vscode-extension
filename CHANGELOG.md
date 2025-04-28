# Change Log

All notable changes to the "playcanvas" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [v0.1.0]

- Initial release

## [v0.1.6]

- Auth token is served in a more secure way now

## [v0.1.7]

- Authentication is reworked, only auth token from PlayCanvas account page is needed. Username and auth token settings removed from VS Code settings for PlayCanvas. Token is requested in a dialog.
- Issue with failing 'Add Project' command is fixed.

## [v0.1.8]

- Hotfix for the previous release.

## [v0.1.9]

- Find In Files implemented.
- Issue with opened files during VS Code startup is fixed.

## [v0.2.0]

- Current branch is displayed in the status bar when source file is active. Click it to switch branches.
- Tooltips with current branch.
- Current branch is memorized in workspace data (if it's saved)

## [v0.2.1]

- The issue with authorization is fixed

## [v0.2.2]

- If the user provides a bad token, show an error message [PR](https://github.com/playcanvas/vscode-extension/pull/29) by [Christopher-Hayes](https://github.com/Christopher-Hayes)
- Improve File Asset Syncing [PR](https://github.com/playcanvas/vscode-extension/pull/26)