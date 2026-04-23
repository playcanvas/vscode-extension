import fs from 'fs';
import path from 'path';

import type * as ts from 'typescript/lib/tsserverlibrary';

const FILES = new Map([
    // global pc namespace
    ['.pc/globals.d.ts', fs.readFileSync(path.join(__dirname, 'playcanvas.d.ts'), 'utf8')],

    // 'playcanvas' module declaration
    ['.pc/module.d.ts', 'declare module "playcanvas" { export = pc; }\n']
]);

const PROJECT_REGEX = /playcanvas\.playcanvas\/\w+\/.+ \(\d+\)/;

const log = (project: ts.server.Project, message: string) => {
    project.projectService.logger.info(`[playcanvas-plugin] ${message}`);
};

const init = (modules: { typescript: typeof ts }): ts.server.PluginModule => {
    const ts = modules.typescript;

    const compilerOptions: ts.CompilerOptions = {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2020,
        lib: ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts']
    };

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

        // project tsconfig wins over plugin defaults; cache by settings
        // identity since ts reuses the object until tsconfig reloads
        let cache: { settings: ts.CompilerOptions; merged: ts.CompilerOptions } | undefined;
        proxy.getCompilationSettings = () => {
            const settings = getCompilationSettings();
            if (cache?.settings === settings) {
                return cache.merged;
            }
            const merged = { ...compilerOptions, ...settings };
            merged.lib = [...(compilerOptions.lib ?? []), ...(settings.lib ?? [])];
            cache = { settings, merged };
            return merged;
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

        // openClientFile registers ScriptInfo so ambient module declarations resolve.
        // the /.pc guard above prevents the re-entrant project creation this used to cause.
        const paths: string[] = [];
        for (const [name, content] of FILES) {
            const filePath = ts.server.toNormalizedPath(path.join(projectDir, name));
            if (!project.containsFile(filePath)) {
                log(project, `registering virtual file: ${filePath}`);
                project.projectService.openClientFile(filePath, content, ts.ScriptKind.TS);
            }
            paths.push(filePath);
        }
        return paths;
    };

    return { create, getExternalFiles };
};

// use export = to ensure it's commonjs
export = init;
