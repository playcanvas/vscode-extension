# PlayCanvas VS Code Extension

![Copilot with PlayCanvas extension](/images/extension-ai.gif)

Extension that integrates with the PlayCanvas platform and helps to use a rich ecosystem of Visual Studio Code to work with PlayCanvas assets. The extension provides an interface to interact with PlayCanvas scripts and text-based files stored in cloud storage through an Explorer-like TreeView. The extension supports common file operations, version control features, collaboration capabilities and "Find In Files" functionality.

## Usage

* Download and install extension in VS Code.
* Generate an access token on your [PlayCanvas account page](https://playcanvas.com/account) - check [this document](https://developer.playcanvas.com/en/user-manual/api/#authorization) for details.
* Open VS Code, enter the token and PlayCanvas username on extension settings page. Search for 'playcanvas' in VS Code settings.
* Select "PlayCanvas: Add Project" command in VS Code command menu

![Extension settings](/images/settings.jpg)

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

The extension integrates with PlayCanvas' version control system, allowing users to switch between branches of a PlayCanvas project. Switching branch is an action in a context menu for a project. After switching the branch, all operations happen in the current branch. 

#### Collaboration

The extension supports collaboration features of PlayCanvas. Multiple users can edit a PlayCanvas project simultaneously, with changes being synchronized manually between users. Users are prevented from overwriting files, edited by others by checking modification base time in update requests on the backend - if it’s different, it means that file was modified by someone else. After that, a customer can pull the latest version of the file by choosing ‘Pull latest’ from the context menu for the file. 

#### Find In Files

The extension includes a "Find In Files" feature. Users can search for a text string across all script and text files in the PlayCanvas project. The search results are presented in a panel in VS Code, and users can navigate to the matching locations in files directly from the search results.

#### Settings

The extension has 2 settings - Access Token and PlayCanvas username. 

## Requirements

* An existing PlayCanvas account with an access token generated.

## Extension Settings

* `playcanvas.accessToken`: Generate an access token on your [account page](https://playcanvas.com/account).
* `playcanvas.username`: Set to your PlayCanvas username.

## Known Issues

* Find in Files is not yet implemented for the Beta test.

---

## For more information

* [PlayCanvas Documentation](https://developer.playcanvas.com/)

**Enjoy!**
