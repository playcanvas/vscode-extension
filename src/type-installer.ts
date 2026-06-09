import type * as childProcess from 'node:child_process';

import * as vscode from 'vscode';

import { ENV, PLAYCANVAS_VERSION, WEB } from './config';
import { Log } from './log';
import * as buffer from './utils/buffer';
import { tryCatch, tryCatchSync } from './utils/utils';

const MANIFEST = 'playcanvas-types.json';
const MODULE_DTS = 'declare module "playcanvas" { export = pc; }\n';
const INSTALL_TIMEOUT_MS = 2 * 60 * 1000;

export type TypeFiles = {
    globals: Uint8Array;
    module: Uint8Array;
    version: string;
    fallback: boolean;
};

type Manifest = {
    playcanvas?: string;
    registry?: string;
};

type ChildProcess = typeof childProcess;

const WIN = process.platform === 'win32';

const npm = () => (WIN ? 'npm.cmd' : 'npm');

const normalize = (version?: string) => (version || PLAYCANVAS_VERSION).replace(/^v/i, '');

const run = async (proc: ChildProcess, cmd: string, args: string[], cwd: string) => {
    return new Promise<string>((resolve, reject) => {
        // npm.cmd is a batch file — windows needs shell:true to run it, and shell space-joins args, so quote any with spaces
        const child = proc.spawn(cmd, WIN ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, {
            cwd,
            windowsHide: true,
            shell: WIN
        });
        const chunks: string[] = [];
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`${cmd} ${args.join(' ')} timed out`));
        }, INSTALL_TIMEOUT_MS);

        child.stdout.on('data', (chunk: Uint8Array) => chunks.push(buffer.toString(chunk)));
        child.stderr.on('data', (chunk: Uint8Array) => chunks.push(buffer.toString(chunk)));
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(chunks.join(''));
                return;
            }
            reject(new Error(`${cmd} ${args.join(' ')} failed with exit code ${code}: ${chunks.join('')}`));
        });
    });
};

class TypeInstaller {
    private _log = new Log(this.constructor.name);

    private _context: vscode.ExtensionContext;

    private _fallback?: Uint8Array;

    private _running = new Map<string, Promise<TypeFiles>>();

    private _warned = new Set<string>();

    constructor({ context }: { context: vscode.ExtensionContext }) {
        this._context = context;
    }

    private _cache(projectId: number) {
        const rootUri = WEB ? this._context.globalStorageUri : vscode.Uri.file(this._context.globalStorageUri.fsPath);
        return vscode.Uri.joinPath(rootUri, 'types', `${ENV}-${projectId}`);
    }

    private async _manifest(cacheUri: vscode.Uri) {
        const uri = vscode.Uri.joinPath(cacheUri, MANIFEST);
        const [readErr, raw] = await tryCatch(vscode.workspace.fs.readFile(uri) as Promise<Uint8Array>);
        if (readErr) {
            return {};
        }

        const [parseErr, data] = tryCatchSync(() => JSON.parse(buffer.toString(raw)) as Manifest);
        if (parseErr) {
            return {};
        }
        return data;
    }

    private async _readInstalled(cacheUri: vscode.Uri, version: string, fallback = false) {
        const uri = vscode.Uri.joinPath(cacheUri, 'node_modules', 'playcanvas', 'build', 'playcanvas.d.ts');
        const [err, globals] = await tryCatch(vscode.workspace.fs.readFile(uri) as Promise<Uint8Array>);
        if (err) {
            return;
        }
        return {
            globals,
            module: buffer.from(MODULE_DTS),
            version,
            fallback
        };
    }

    private async _readFallback() {
        if (this._fallback) {
            return this._fallback;
        }

        const uri = vscode.Uri.joinPath(this._context.extensionUri, 'out', 'playcanvas.d.ts');
        const [err, globals] = await tryCatch(vscode.workspace.fs.readFile(uri) as Promise<Uint8Array>);
        if (!err) {
            this._fallback = globals;
            return globals;
        }

        const devUri = vscode.Uri.joinPath(
            this._context.extensionUri,
            'node_modules',
            'playcanvas',
            'build',
            'playcanvas.d.ts'
        );
        const [, devGlobals] = await tryCatch(vscode.workspace.fs.readFile(devUri) as Promise<Uint8Array>);
        this._fallback = devGlobals ?? buffer.from('declare namespace pc {}\n');
        return this._fallback;
    }

    private async _fallbackTypes(projectId: number, version: string, reason: string, cacheUri?: vscode.Uri) {
        this._log.warn(`PlayCanvas types for ${version} could not be updated`, reason);
        if (cacheUri) {
            const manifest = await this._manifest(cacheUri);
            const installed = await this._readInstalled(cacheUri, manifest.playcanvas ?? version, true);
            if (installed) {
                this._warn(projectId, version, `${reason}. Using cached PlayCanvas types.`);
                return installed;
            }
        }

        this._warn(projectId, version, `${reason}. Using bundled fallback types.`);
        return {
            globals: await this._readFallback(),
            module: buffer.from(MODULE_DTS),
            version: PLAYCANVAS_VERSION,
            fallback: true
        };
    }

    private _warn(projectId: number, version: string, message: string) {
        const suffix = ' See the PlayCanvas output for details.';
        const limit = 240 - suffix.length;
        const detail = `${message.length > limit ? `${message.slice(0, limit)}...` : message}${suffix}`;
        const key = `${projectId}:${version}:${detail}`;
        if (this._warned.has(key)) {
            return;
        }
        this._warned.add(key);
        void vscode.window.showWarningMessage(`PlayCanvas types for ${version} could not be updated: ${detail}`);
    }

    private async _install(projectId: number, raw: string) {
        const version = normalize(raw);
        const cacheUri = this._cache(projectId);

        this._log.info(`type cache uri=${cacheUri.toString()} scheme=${cacheUri.scheme} fsPath=${cacheUri.fsPath}`);
        if (WEB) {
            return this._fallbackTypes(projectId, version, 'npm is unavailable in web extension host', cacheUri);
        }

        await vscode.workspace.fs.createDirectory(cacheUri);
        const manifest = await this._manifest(cacheUri);
        if (manifest.playcanvas === version && manifest.registry === 'https://registry.npmjs.org/') {
            const installed = await this._readInstalled(cacheUri, version);
            if (installed) {
                return installed;
            }
        }

        const [importErr, proc] = await tryCatch(import(['node', 'child_process'].join(':')) as Promise<ChildProcess>);
        if (importErr) {
            return this._fallbackTypes(projectId, version, 'npm could not be loaded', cacheUri);
        }

        const cmd = npm();
        const [npmErr] = await tryCatch(run(proc, cmd, ['--version'], cacheUri.fsPath));
        if (npmErr) {
            return this._fallbackTypes(projectId, version, 'npm was not found', cacheUri);
        }

        this._log.info(`installing playcanvas@${version} from https://registry.npmjs.org/ into ${cacheUri.fsPath}`);
        const args = [
            'install',
            '--prefix',
            cacheUri.fsPath,
            '--registry=https://registry.npmjs.org/',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--package-lock=false',
            '--save=false',
            `playcanvas@${version}`
        ];
        const [installErr] = await tryCatch(run(proc, cmd, args, cacheUri.fsPath));
        if (installErr) {
            return this._fallbackTypes(projectId, version, installErr.message, cacheUri);
        }

        const installed = await this._readInstalled(cacheUri, version);
        if (!installed) {
            return this._fallbackTypes(
                projectId,
                version,
                'installed package did not include playcanvas.d.ts',
                cacheUri
            );
        }

        const uri = vscode.Uri.joinPath(cacheUri, MANIFEST);
        await vscode.workspace.fs.writeFile(
            uri,
            buffer.from(JSON.stringify({ playcanvas: version, registry: 'https://registry.npmjs.org/' }, undefined, 2))
        );
        return installed;
    }

    async install({ projectId, version }: { projectId: number; version: string }) {
        const key = `${ENV}:${projectId}:${normalize(version)}`;
        const running = this._running.get(key);
        if (running) {
            return running;
        }

        const task = this._install(projectId, version);
        this._running.set(key, task);
        const [err, types] = await tryCatch(task);
        this._running.delete(key);
        if (err) {
            return this._fallbackTypes(projectId, normalize(version), err.message);
        }
        return types;
    }
}

export { TypeInstaller };
