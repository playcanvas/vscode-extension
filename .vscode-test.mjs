import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: 'out/test/**/*.test.js',
    workspaceFolder: './.vscode-storage/prod/Test Project (1)',
    mocha: {
        timeout: 5000
    },
    env: {
        ROOT_FOLDER: `${import.meta.dirname}/.vscode-storage`
    }
});
