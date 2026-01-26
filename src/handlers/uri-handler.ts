import * as vscode from 'vscode';

import { NAME, PUBLISHER } from '../config';
import type { Rest } from '../connections/rest';
import type { ProjectManager } from '../project-manager';
import { Linker } from '../utils/linker';
import { signal } from '../utils/signal';
import { fileExists, projectToName, guard } from '../utils/utils';

type OpenFile = {
    assetId: number;
    line: number | undefined;
    col: number | undefined;
    error: boolean;
};

class UriHandler
    extends Linker<{ folderUri: vscode.Uri; projectManager: ProjectManager }>
    implements vscode.UriHandler
{
    static OPEN_FILE_KEY = `${NAME}.openFile`;

    static ERROR_COLOR = 'rgba(244, 67, 54, 0.2)';

    private _context: vscode.ExtensionContext;

    private _rootUri: vscode.Uri;

    private _userId: number;

    private _rest: Rest;

    private _folderUri?: vscode.Uri;

    protected _projectManager?: ProjectManager;

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
        super();

        this._context = context;
        this._rootUri = rootUri;
        this._userId = userId;
        this._rest = rest;

        this._context.subscriptions.push(this._errorDecoration);
    }

    protected async _openDocument(folderUri: vscode.Uri, projectManager: ProjectManager, open: OpenFile) {
        const { assetId, line, col, error } = open;

        // check if file path exists
        const filePath = projectManager.path(assetId);
        if (!filePath) {
            this._log.warn(`file not found in ${folderUri.toString()}`);
            return;
        }

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

        this._log.info(`opened asset ${assetId} at ${filePath}`);
    }

    protected async _openFile(folderUri: vscode.Uri, projectManager: ProjectManager) {
        // retrieve and clear stored open file (always consume)
        const open = this._context.globalState.get<
            OpenFile & {
                folderUriStr: string;
            }
        >(UriHandler.OPEN_FILE_KEY);
        await this._context.globalState.update(UriHandler.OPEN_FILE_KEY, undefined);

        // check if we need to open a file
        if (!open || !open.assetId) {
            return;
        }

        // check if file is for the current project
        if (open.folderUriStr !== folderUri.toString()) {
            return;
        }

        // open text document
        await this._openDocument(folderUri, projectManager, open);
    }

    async handleUri(uri: vscode.Uri) {
        if (uri.authority !== `${PUBLISHER}.${NAME}`) {
            return;
        }

        // validate path
        const groups = /^\/project\/(\d+)(?:\/asset\/(\d+))?(\/?)$/.exec(uri.path);
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

        // parse uri: /project/{projectId}[/asset/{assetId}][?line={line}&col={col}&error={error}]
        const projectId = parseInt(groups[1]);
        const assetId = groups[2] !== undefined ? parseInt(groups[2]) : undefined;
        this._log.debug(
            [
                `parsed project ${projectId}`,
                assetId ? `asset ${assetId}` : '',
                line ? `line ${line}` : '',
                col ? `col ${col}` : '',
                error ? 'error' : ''
            ]
                .filter(Boolean)
                .join(' ')
        );

        // fetch all user projects
        const projects = await guard(this._rest.userProjects(this._userId, 'profile'), this.error);

        // find matching project
        const project = projects.find((p) => p.id === projectId);
        if (!project) {
            this.error.set(() => new Error(`project ${projectId} not found`));
            return;
        }

        // build folder uri
        const folderUri = vscode.Uri.joinPath(this._rootUri, projectToName(project));

        // check if current workspace already has the project opened
        if (this._projectManager && this._folderUri?.toString() === folderUri.toString()) {
            // open file if asset id is provided
            if (assetId) {
                await this._openDocument(folderUri, this._projectManager, { assetId, line, col, error });
            }
            return;
        }

        // save full path to global storage for later retrieval
        await this._context.globalState.update(UriHandler.OPEN_FILE_KEY, {
            folderUriStr: folderUri.toString(),
            assetId,
            line,
            col,
            error
        });

        // open project folder
        await vscode.workspace.fs.createDirectory(folderUri);
        await vscode.commands.executeCommand('vscode.openFolder', folderUri, false);
    }

    async link({ folderUri, projectManager }: { folderUri: vscode.Uri; projectManager: ProjectManager }) {
        if (this._folderUri || this._projectManager) {
            throw this.error.set(() => new Error('manager already linked'));
        }

        this._folderUri = folderUri;
        this._projectManager = projectManager;

        await this._openFile(folderUri, projectManager);

        this._log.info(`linked to ${folderUri.toString()}`);
    }

    async unlink() {
        if (!this._folderUri || !this._projectManager) {
            throw this.error.set(() => new Error('manager not linked'));
        }
        const folderUri = this._folderUri;
        const projectManager = this._projectManager;

        await super.unlink();

        this._log.info(`unlinked from ${folderUri.toString()}`);

        return { folderUri, projectManager };
    }
}

export { type OpenFile, UriHandler };
