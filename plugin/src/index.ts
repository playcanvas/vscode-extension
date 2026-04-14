import fs from 'fs';
import path from 'path';

import type * as ts from 'typescript/lib/tsserverlibrary';

const DEBUG = true;
const FILES = new Map([
    // global pc namespace
    ['.pc/globals.d.ts', fs.readFileSync(path.join(__dirname, 'playcanvas.d.ts'), 'utf8')],

    // 'playcanvas' module declaration
    ['.pc/module.d.ts', 'declare module "playcanvas" { export = pc; }\n']
]);

const COMPILER_OPTIONS: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true
};

const PROJECT_REGEX = /playcanvas\.playcanvas\/\w+\/[\w\s]+ \(\d+\)/;

const log = (project: ts.server.Project, message: string) => {
    if (!DEBUG) {
        return;
    }
    project.projectService.logger.info(`[PLUGIN] ${message}`);
};

const init = (modules: { typescript: typeof ts }): ts.server.PluginModule => {
    const ts = modules.typescript;

    const create = (info: ts.server.PluginCreateInfo): ts.LanguageService => {
        // check if we are inside a project
        const projectDir = info.project.getCurrentDirectory();
        if (!PROJECT_REGEX.test(projectDir) || projectDir.includes('/.pc')) {
            return info.languageService;
        }
        log(info.project, `Initializing plugin ${projectDir}`);

        // add virtual file paths
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
                const rel = path.relative(projectDir, fileName).replace(/\\/g, '/');
                return ts.ScriptSnapshot.fromString(FILES.get(rel)!);
            }
            return getScriptSnapshot(fileName);
        };

        // intercept readFile to provide content for the virtual file
        proxy.readFile = (fileName, encoding) => {
            if (paths.includes(fileName)) {
                log(info.project, `Reading content for virtual file: ${fileName}`);
                const rel = path.relative(projectDir, fileName).replace(/\\/g, '/');
                return FILES.get(rel)!;
            }
            return readFile(fileName, encoding);
        };

        return info.languageService;
    };

    const getExternalFiles = (project: ts.server.Project): string[] => {
        const projectDir = project.getCurrentDirectory();

        // prevent infinite recursion from inferred projects inside .pc/ subdirectories
        if (projectDir.includes('/.pc')) {
            return [];
        }

        if (!PROJECT_REGEX.test(projectDir)) {
            return [];
        }

        const paths: string[] = [];
        for (const [name] of FILES) {
            paths.push(ts.server.toNormalizedPath(path.join(projectDir, name)));
        }
        return paths;
    };

    return { create, getExternalFiles };
};

// use export = to ensure it's commonjs
export = init;
