import * as vscode from 'vscode';

import { NAME, PUBLISHER } from '../config';
import type { Rest } from '../connections/rest';
import { tryCatch, fileExists, projectToName } from '../utils/utils';

class UriHandler implements vscode.UriHandler {
    static OPEN_FILE_KEY = `${NAME}.openFile`;

    private _context: vscode.ExtensionContext;

    private _rootUri: vscode.Uri;

    private _userId: number;

    private _rest: Rest;

    constructor({
        context,
        rootUri,
        userId,
        rest
    }: {
        context: vscode.ExtensionContext;
        rootUri: vscode.Uri;
        userId: number;
        rest: Rest;
    }) {
        this._context = context;
        this._rootUri = rootUri;
        this._userId = userId;
        this._rest = rest;
    }

    async handleUri(uri: vscode.Uri) {
        if (uri.authority !== `${PUBLISHER}.${NAME}`) {
            return;
        }

        // validate path
        if (!/\/.+\s\(\d+\)(\/.*)?$/.test(uri.path)) {
            return;
        }

        // parse uri: /{projectName} ({projectId})/{filePath}
        const [_blank, projectName, ...pathParts] = uri.path.split('/');
        const filePath = pathParts.join('/');

        // fetch all user projects
        const [error, projects] = await tryCatch(this._rest.userProjects(this._userId, 'profile'));
        if (error) {
            return;
        }

        // find matching project
        const project = projects.find((p) => projectToName(p) === projectName);
        if (!project) {
            return;
        }

        // build folder uri
        const folderUri = vscode.Uri.joinPath(this._rootUri, projectToName(project));

        // check if current workspace already has the project opened
        const folders = vscode.workspace.workspaceFolders ?? [];
        const folder = folders.find((f) => f.uri.toString() === folderUri.toString());
        if (folder) {
            if (filePath) {
                // open file
                const openUri = vscode.Uri.joinPath(folderUri, filePath);
                if (await fileExists(openUri)) {
                    const openDoc = await vscode.workspace.openTextDocument(openUri);
                    await vscode.window.showTextDocument(openDoc);
                }
            }
            return;
        }

        // save full path to global storage for later retrieval
        await this._context.globalState.update(UriHandler.OPEN_FILE_KEY, {
            folderUriStr: folderUri.toString(),
            filePath
        });

        // open project folder
        await vscode.workspace.fs.createDirectory(folderUri);
        await vscode.commands.executeCommand('vscode.openFolder', folderUri, false);
    }

    async getOpenFilePath(folderUri: vscode.Uri): Promise<string | undefined> {
        // retrieve and clear stored open file (always consume)
        const openFile = this._context.globalState.get<{
            folderUriStr: string;
            filePath: string;
        }>(UriHandler.OPEN_FILE_KEY);
        await this._context.globalState.update(UriHandler.OPEN_FILE_KEY, undefined);

        // check if valid
        if (!openFile) {
            return;
        }
        if (openFile.folderUriStr !== folderUri.toString()) {
            return;
        }

        return openFile.filePath;
    }
}

export { UriHandler };
