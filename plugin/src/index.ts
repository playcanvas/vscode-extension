import fs from 'fs';
import path from 'path';

import type * as ts from 'typescript/lib/tsserverlibrary';

const DEBUG = true;
const FILES = new Map([
    // global pc namespace
    ['globals.d.ts', fs.readFileSync(path.join(__dirname, 'playcanvas.d.ts'), 'utf8')],

    // 'playcanvas' module declaration
    ['module.d.ts', 'declare module "playcanvas" { export = pc; }']
]);

const COMPILER_OPTIONS: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true
};

const log = (project: ts.server.Project, message: string) => {
    if (!DEBUG) {
        return;
    }
    project.projectService.logger.info(`[PLUGIN] ${message}`);
};

const init = (modules: { typescript: typeof ts }): ts.server.PluginModule => {
    const ts = modules.typescript;

    const create = (info: ts.server.PluginCreateInfo): ts.LanguageService => {
        log(info.project, `Initializing plugin...`);

        // Get the project's root directory to form a normalized, unique path for the virtual file
        const projectDir = info.project.getCurrentDirectory();
        const paths: string[] = [];
        for (const [name] of FILES) {
            paths.push(ts.server.toNormalizedPath(path.join(projectDir, name)));
        }

        const proxy = info.languageServiceHost;
        const getScriptSnapshot = proxy.getScriptSnapshot.bind(proxy);
        const readFile = proxy.readFile.bind(proxy);
        const getCompilationSettings = proxy.getCompilationSettings.bind(proxy);

        // intercept to merge custom compiler options to enable JS support
        proxy.getCompilationSettings = () => {
            const settings = getCompilationSettings();
            log(info.project, `Merging custom compiler options into project settings.`);
            return Object.assign(settings, COMPILER_OPTIONS);
        };

        // intercept getScriptSnapshot to provide a snapshot for the virtual file
        proxy.getScriptSnapshot = (fileName) => {
            if (paths.includes(fileName)) {
                log(info.project, `Providing snapshot for virtual file: ${fileName}`);
                return ts.ScriptSnapshot.fromString(FILES.get(path.basename(fileName))!);
            }
            return getScriptSnapshot(fileName);
        };

        // intercept readFile to provide content for the virtual file
        proxy.readFile = (fileName, encoding) => {
            if (paths.includes(fileName)) {
                log(info.project, `Reading content for virtual file: ${fileName}`);
                return FILES.get(path.basename(fileName))!;
            }
            return readFile(fileName, encoding);
        };

        return info.languageService;
    };

    const getExternalFiles = (project: ts.server.Project): string[] => {
        const projectDir = project.getCurrentDirectory();
        const pathsNormalized: ts.server.NormalizedPath[] = [];

        for (const [fileName, content] of FILES) {
            const filePath = ts.server.toNormalizedPath(path.join(projectDir, fileName));

            // If the file is not already part of the project, add it as an external file
            if (!project.containsFile(filePath)) {
                log(project, `Adding external file to project: ${filePath}`);
                project.projectService.openClientFile(filePath, content, ts.ScriptKind.TS);
            }

            pathsNormalized.push(filePath);
        }
        return pathsNormalized;
    };

    return { create, getExternalFiles };
};

// use export = to ensure its commonjs
export = init;
