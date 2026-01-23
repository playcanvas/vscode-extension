import * as vscode from 'vscode';

import { NAME, PUBLISHER } from '../config';
import type { Rest } from '../connections/rest';
import { Log } from '../log';
import { signal } from '../utils/signal';
import { fileExists, projectToName, guard } from '../utils/utils';

type OpenFile = {
    filePath: string;
    line: number | undefined;
    col: number | undefined;
};

class UriHandler implements vscode.UriHandler {
    static OPEN_FILE_KEY = `${NAME}.openFile`;

    private _log = new Log(this.constructor.name);

    private _context: vscode.ExtensionContext;

    private _rootUri: vscode.Uri;

    private _userId: number;

    private _rest: Rest;

    error = signal<Error | undefined>(undefined);

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
        const groups = /^\/(.+)\s\((\d+)\)(\/.*)?$/.exec(uri.path);
        if (!groups) {
            return;
        }

        // parse line and column from query params
        const params = new URLSearchParams(uri.query);
        const l = params.get('line') || '';
        const c = params.get('col') || '';
        let line: number | undefined;
        let col: number | undefined;
        if (/^\d+$/.test(l)) {
            line = Math.max(parseInt(l) - 1, 0);
        }
        if (/^\d+$/.test(c)) {
            col = Math.max(parseInt(c) - 1, 0);
        }

        // parse uri: /{projectName} ({projectId})/{filePath}
        const [projectName, projectId, filePath = '/'] = groups.slice(1);
        this._log.debug(projectName, projectId, filePath, line, col);

        // fetch all user projects
        const projects = await guard(this._rest.userProjects(this._userId, 'profile'), this.error);

        // find matching project
        const project = projects.find((p) => p.id === parseInt(projectId) && p.name === projectName);
        if (!project) {
            this.error.set(() => new Error(`project ${projectName} not found`));
            return;
        }

        // build folder uri
        const folderUri = vscode.Uri.joinPath(this._rootUri, projectToName(project));

        // check if current workspace already has the project opened
        const folders = vscode.workspace.workspaceFolders ?? [];
        const folder = folders.find((f) => f.uri.toString() === folderUri.toString());
        if (folder) {
            if (filePath !== '/') {
                // open file if it exists
                await this.showFile(folderUri, { filePath, line, col });
            }
            return;
        }

        // save full path to global storage for later retrieval
        await this._context.globalState.update(UriHandler.OPEN_FILE_KEY, {
            folderUriStr: folderUri.toString(),
            filePath,
            line,
            col
        });

        // open project folder
        await vscode.workspace.fs.createDirectory(folderUri);
        await vscode.commands.executeCommand('vscode.openFolder', folderUri, false);
    }

    async openFile(folderUri: vscode.Uri): Promise<OpenFile | undefined> {
        // retrieve and clear stored open file (always consume)
        const openFile = this._context.globalState.get<
            OpenFile & {
                folderUriStr: string;
            }
        >(UriHandler.OPEN_FILE_KEY);
        await this._context.globalState.update(UriHandler.OPEN_FILE_KEY, undefined);

        // check if valid
        if (!openFile) {
            return;
        }
        if (openFile.folderUriStr !== folderUri.toString()) {
            return;
        }

        return {
            filePath: openFile.filePath,
            line: openFile.line,
            col: openFile.col
        };
    }

    async showFile(folderUri: vscode.Uri, openFile: OpenFile) {
        const openUri = vscode.Uri.joinPath(folderUri, openFile.filePath);
        if (!(await fileExists(openUri))) {
            this._log.warn(`file does not exist: ${openUri.toString()}`);
            return;
        }

        const options: vscode.TextDocumentShowOptions = {};
        if (openFile.line !== undefined && openFile.col !== undefined) {
            options.selection = new vscode.Range(openFile.line, openFile.col, openFile.line, openFile.col);
        }
        const openDoc = await vscode.workspace.openTextDocument(openUri);
        await vscode.window.showTextDocument(openDoc, options);
    }
}

export { type OpenFile, UriHandler };
