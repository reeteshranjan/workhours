import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './web/svelte.config.js';

export default defineConfig([
  globalIgnores([
    'dist/',
    '.dev-data/',
    '.e2e-data/',
    'node_modules/',
    'test-results/',
    'playwright-report/',
  ]),
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // Keep this the same for TypeScript and Svelte files to avoid parser reloads.
        extraFileExtensions: ['.svelte'],
      },
    },
  },
  {
    files: ['web/**'],
    ignores: ['web/public/sw.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // The service worker runs outside any page: its globals are `self`, `clients` and so on.
    files: ['web/public/sw.js'],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: {
        // Parse <script lang="ts"> with typescript-eslint's parser.
        parser: ts.parser,
        svelteConfig,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Last, so that it turns off any formatting rules that clash with Prettier.
  prettier,
  svelte.configs.prettier,
]);
