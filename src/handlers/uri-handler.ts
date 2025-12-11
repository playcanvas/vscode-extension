import * as vscode from 'vscode';

import type { Rest } from '../connections/rest';
import { projectToName, uriStartsWith } from '../utils/utils';

type OpenFileState = {
    folderUriStr: string;
    filePath: string;
};

class UriHandler implements vscode.UriHandler {
    static OPEN_FILE_KEY = 'playcanvas.openFile';

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
        if (uri.authority !== 'playcanvas.playcanvas') {
            return;
        }

        // parse uri: /{projectName} ({projectId})/{filePath}
        const [_blank, projectName, ...rest] = uri.path.split('/');
        const filePath = rest.join('/');

        // fetch all user projects
        const projects = await this._rest.userProjects(this._userId, 'profile');

        // find matching project
        const project = projects.find((p) => projectToName(p) === projectName);
        if (!project) {
            return;
        }

        // build folder uri
        const folderUri = vscode.Uri.joinPath(this._rootUri, projectToName(project));

        // check if current workspace is already the project
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (
            folders.length === 1 &&
            uriStartsWith(folders[0].uri, this._rootUri) &&
            folders[0].name === projectToName(project)
        ) {
            if (filePath) {
                // open file
                const fileUri = vscode.Uri.joinPath(folderUri, filePath);
                await vscode.commands.executeCommand('vscode.open', fileUri);
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

    async flushOpenFile(): Promise<OpenFileState | undefined> {
        const openFile = this._context.globalState.get<OpenFileState>(UriHandler.OPEN_FILE_KEY);
        await this._context.globalState.update(UriHandler.OPEN_FILE_KEY, undefined);
        return openFile;
    }
}

export { UriHandler };
