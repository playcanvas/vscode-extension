import eslint from '@eslint/js';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { defineConfig } from 'eslint/config';
import pluginImport from 'eslint-plugin-import';
import * as pluginPackageJson from 'eslint-plugin-package-json';
import pluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import jsoncEslintParser from 'jsonc-eslint-parser';
import tseslint from 'typescript-eslint';

const ignoreConfig = {
    ignores: ['**/node_modules', '**/out', '.vscode-test*/**', '.vscode-storage/**'],
};

const baseConfig = {
    rules: {
        curly: 'error',
        'import/order': [
            'error',
            {
                alphabetize: { order: 'asc', caseInsensitive: true },
                'newlines-between': 'always',
                groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'object'],
            },
        ],
        '@typescript-eslint/no-invalid-void-type': 'off',
        '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
        '@typescript-eslint/no-unused-vars': [
            'error',
            {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            },
        ],
    },
    settings: {
        'import/resolver': {
            typescript: true,
        },
    },
};

const tsFilesConfig = {
    files: ['**/*.{js,mjs,ts}'],
    plugins: {
        '@typescript-eslint': typescriptEslint,
    },
    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: 'module',
        globals: globals.node,
    },
    rules: {
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/no-dynamic-delete': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
    },
};

const packageJsonConfig = {
    files: ['**/package.json', '**/package-lock.json'],
    languageOptions: {
        parser: jsoncEslintParser,
    },
    plugins: {
        'package-json': pluginPackageJson,
    },
    rules: pluginPackageJson.configs.recommended.rules,
};

export default defineConfig(
    eslint.configs.recommended,
    tseslint.configs.recommended,
    tseslint.configs.strict,
    tseslint.configs.stylistic,
    pluginPrettierRecommended,
    pluginImport.flatConfigs.recommended,
    ignoreConfig,
    baseConfig,
    tsFilesConfig,
    packageJsonConfig,
);
