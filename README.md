# PlayCanvas VS Code Extension

![Copilot with PlayCanvas extension](/images/vscode-extension.webp)

Extension that integrates with the PlayCanvas platform and helps to use a rich ecosystem of Visual Studio Code to work with PlayCanvas assets. The extension provides an interface to interact with PlayCanvas scripts and text-based files stored in cloud storage through an Explorer-like TreeView. The extension supports common file operations, version control features and collaboration capabilities.

## Usage

* Download and install extension in VS Code.
* Generate an access token on your [PlayCanvas account page](https://playcanvas.com/account) - check [this document](https://developer.playcanvas.com/en/user-manual/api/#authorization) for details, copy it to clipboard
* Select "PlayCanvas: Add Project" command in VS Code command menu and paste your token into the message box.
* Work with your project in VS Code workspace.

## Features

#### PlayCanvas Hierarchical Explorer

The extension adds a TreeView in the Explorer sidebar of VS Code, showing all script and text files in customer’s PlayCanvas projects. This provides a familiar interface for users to browse and manage their PlayCanvas files. All projects can be accessed and edited simultaneously.

#### PlayCanvas Cloud Storage Provider

The extension acts as a Cloud Storage Provider for VS Code. It connects to PlayCanvas' APIs to read and write files, allowing users to edit PlayCanvas files directly in VS Code.

#### File Operations

The extension supports common file operations:

* Copy-Pasting: Users can copy and paste files and folders, even between projects.
* Deleting: Users can delete files and folders.
* Renaming: Users can rename files and folders.
* New File/Folder: Create new assets and folders directly in the project

These operations are available through context menu commands in the TreeView.

#### Copilot

Copilot, Microsoft’s AI code generator, works fine with the extension and allows customers to generate blocks of code after entering a prompt or just based on the context of code. 

#### Version Control

The extension integrates with PlayCanvas' version control system, allowing users to switch between branches of a PlayCanvas project. Switching branch is an action in a context menu for a project. After switching the branch, all operations happen in the current branch. Current branch is saved into workspace data, so save workspace if persistance needed. 

#### Collaboration

The extension supports collaboration features of PlayCanvas. Multiple users can edit a PlayCanvas project simultaneously, with changes being synchronized manually between users. Users are prevented from overwriting files, edited by others by checking modification base time in update requests on the backend - if it’s different, it means that file was modified by someone else. After that, a customer can pull the latest version of the file by choosing ‘Pull latest’ from the context menu for the file. 

#### Find in Files

The extension supports searching in project files - use `PlayCanvas: Search` to search in the current project or `PlayCanvas:Find In Files` from the context menu to search for a pattern. The search is case-insensitive and the maximum number of results is controlled by the `maxSearchResults` setting. As soon as the standard Search Dialog is [supported by the VS Code API](https://github.com/microsoft/vscode/issues/73524), we will reimplement it. Currently, the standard Find dialog searches in opened files only, so please use the PlayCanvas one instead. The default shortcut is `Cmd+Shift+'`. Customize this shortcut in the VS Code settings (search for the `PlayCanvas: Search` command).

#### Settings

The extension has just 2 settings: 

* `usePlaycanvasTypes` (to add types support). An Access Token is requested when you are adding a project.
* `maxSearchResults` - the maximum number of search results to display.

## Requirements

* An existing PlayCanvas account with an access token generated.

## Extension Settings

* `playcanvas.usePlaycanvasTypes`: Automatically adds a reference to PlayCanvas types files for code suggestions. Line is not saved. Default is true.
* `playcanvas.maxSearchResults`: Maximum number of search results to display.
* `playcanvas.additionalTypeScriptDefinitionFiles`: Automatically adds references to user specified TypeScript definition files (.d.ts). These references are not saved. Paths must be absolute.

A PlayCanvas Access Token is requested when you add a project. Generate an access token on your [account page](https://playcanvas.com/account).

---

## For more information

* [PlayCanvas Documentation](https://developer.playcanvas.com/)

**Enjoy!**
