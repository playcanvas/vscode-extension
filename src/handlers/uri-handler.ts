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
    error: boolean;
};

class UriHandler implements vscode.UriHandler {
    static OPEN_FILE_KEY = `${NAME}.openFile`;

    static ERROR_COLOR = 'rgba(244, 67, 54, 0.2)';

    private _log = new Log(this.constructor.name);

    private _context: vscode.ExtensionContext;

    private _rootUri: vscode.Uri;

    private _userId: number;

    private _rest: Rest;

    private _errorDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: UriHandler.ERROR_COLOR,
        isWholeLine: true,
        overviewRulerColor: UriHandler.ERROR_COLOR,
        overviewRulerLane: vscode.OverviewRulerLane.Full
    });

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

        this._context.subscriptions.push(this._errorDecoration);
    }

    protected async _openDocument(folderUri: vscode.Uri, open: OpenFile) {
        const { filePath, line, col, error } = open;
        const uri = vscode.Uri.joinPath(folderUri, filePath);

        // check if file exists
        if (!(await fileExists(uri))) {
            this._log.warn(`file does not exist: ${uri.toString()}`);
            return;
        }

        // open text document
        const openDoc = await vscode.workspace.openTextDocument(uri);
        const options: vscode.TextDocumentShowOptions = {};
        const selection = line !== undefined && col !== undefined ? new vscode.Range(line, col, line, col) : undefined;
        if (selection) {
            options.selection = selection;
        }

        // show text document
        const editor = await vscode.window.showTextDocument(openDoc, options);

        // set error decoration
        if (error && selection) {
            editor.setDecorations(this._errorDecoration, [selection]);
        }
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
        const e = params.get('error') || '';
        let line: number | undefined;
        let col: number | undefined;
        const error = e === 'true';
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
                // open text document
                await this._openDocument(folderUri, { filePath, line, col, error });
            }
            return;
        }

        // save full path to global storage for later retrieval
        await this._context.globalState.update(UriHandler.OPEN_FILE_KEY, {
            folderUriStr: folderUri.toString(),
            filePath,
            line,
            col,
            error
        });

        // open project folder
        await vscode.workspace.fs.createDirectory(folderUri);
        await vscode.commands.executeCommand('vscode.openFolder', folderUri, false);
    }

    async openFile(folderUri: vscode.Uri) {
        // retrieve and clear stored open file (always consume)
        const open = this._context.globalState.get<
            OpenFile & {
                folderUriStr: string;
            }
        >(UriHandler.OPEN_FILE_KEY);
        await this._context.globalState.update(UriHandler.OPEN_FILE_KEY, undefined);

        // check if valid
        if (!open) {
            return;
        }

        // check if file is for the current project
        if (open.folderUriStr !== folderUri.toString()) {
            return;
        }

        // open text document
        await this._openDocument(folderUri, open);
    }
}

export { type OpenFile, UriHandler };
