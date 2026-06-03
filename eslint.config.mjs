import typescriptConfig from '@playcanvas/eslint-config/typescript';
import { defineConfig } from 'eslint/config';

export default defineConfig(
    ...typescriptConfig,

    {
        ignores: ['**/node_modules', '**/out', '.vscode-test*/**', '.vscode-storage/**']
    },

    // this extension's package.json intentionally omits these fields
    {
        files: ['**/package.json', '**/package-lock.json'],
        rules: {
            'package-json/require-exports': 'off',
            'package-json/require-sideEffects': 'off'
        }
    },
    {
        files: ['package.json'],
        rules: {
            'package-json/require-files': 'off'
        }
    }
);
