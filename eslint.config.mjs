import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import { readFileSync } from 'node:fs';

// Both file lists below are DERIVED from the tsconfig project that owns them, so
// type-check, lint and execution can never select different files.
const includeGlobs = (tsconfigPath, prefix) =>
  JSON.parse(readFileSync(new URL(tsconfigPath, import.meta.url), 'utf8')).include.map(
    pattern => `${prefix}${pattern}`
  );

const archonScriptFiles = includeGlobs('./.archon/scripts/tsconfig.json', '.archon/scripts/');
const packScriptFiles = includeGlobs('./.archon/workflows/tsconfig.json', '.archon/workflows/');

export default tseslint.config(
  // Global ignores (applied to all configs)
  {
    ignores: [
      'node_modules/**',
      'packages/*/node_modules/**',
      'packages/*/dist/**',
      'dist/**',
      'coverage/**',
      '.agents/examples/**',
      'packages/docs-web/**',
      'workspace/**',
      // Nested git worktrees are separate checkouts that lint on their own branch.
      // Their files are outside every tsconfig project here, so typed rules crash on them.
      'worktrees/**',
      '.worktrees/**',
      '.claude/worktrees/**',
      '.claude/skills/**',
      '.archon/commands/**',
      '.archon/maintainer-standup/**',
      // Workflow packs hold prompts, YAML and fixtures, none of them lintable. Their
      // deterministic scripts are TypeScript and ARE linted, through the globs the
      // pack tsconfig owns, so the ignore names what stays out rather than the tree.
      '.archon/workflows/**/commands/**',
      '.archon/workflows/**/fixtures/**',
      '**/*.generated.ts', // Auto-generated source files (content inlined via JSON.stringify)
      '**/*.js',
      '*.mjs',
      'packages/**/*.test.ts',
      'scripts/**/*.test.ts',
      '**/src/test/**', // Test helper files (mock factories, fixtures)
      '*.d.ts', // Root-level declaration files (not in tsconfig project scope)
      '**/*.generated.d.ts', // Auto-generated declaration files (e.g. openapi-typescript output)
      'packages/web/vite.config.ts', // Vite config doesn't need type-checked linting
    ],
  },

  // Base configs
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // Prettier integration
  prettierConfig,

  // Project-specific settings
  {
    files: [
      'packages/*/src/**/*.{ts,tsx}',
      'scripts/**/*.ts',
      ...archonScriptFiles,
      ...packScriptFiles,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // === ENFORCED RULES (errors) ===
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always'],
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'interface',
          format: ['PascalCase'],
          custom: { regex: '^I?[A-Z]', match: true },
        },
        { selector: 'typeAlias', format: ['PascalCase'] },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE'] },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',

      // === DISABLED RULES ===

      // --- Template/expression rules ---
      // Numbers/booleans in template literals are valid JS (auto-converted to string)
      '@typescript-eslint/restrict-template-expressions': 'off',
      // Mixed operands in + are often intentional (string concatenation)
      '@typescript-eslint/restrict-plus-operands': 'off',

      // --- Defensive coding patterns ---
      // Switch defaults, null checks, and defensive guards are valuable
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Env var checks need || for truthy evaluation (empty string = missing)
      '@typescript-eslint/prefer-nullish-coalescing': 'off',

      // --- External SDK interop (types are often `any` or incomplete) ---
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // Event handler patterns in SDKs often have promise mismatches
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-floating-promises': 'off',

      // --- Style preferences (not critical for type safety) ---
      // Catch variable typing preference
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      // Allow using deprecated APIs during migration periods
      '@typescript-eslint/no-deprecated': 'off',
      // Empty async functions valid for interface compliance
      '@typescript-eslint/require-await': 'off',
      // Constructor style preference
      '@typescript-eslint/consistent-generic-constructors': 'off',
    },
  },

  {
    files: archonScriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './.archon/scripts/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Pack scripts sit outside every package, so typed rules need their owning project
  // named explicitly rather than discovered.
  {
    files: packScriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './.archon/workflows/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Provider attempts are admitted against the operator's concurrency caps. Callers
  // get providers from core's admission seam; the registry's unadmitted
  // getAgentProvider stays reachable only from that seam.
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    ignores: ['packages/providers/src/**', 'packages/core/src/services/provider-admission.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['@archon/providers', '@archon/providers/registry'].map(name => ({
            name,
            importNames: ['getAgentProvider'],
            message:
              "Use getAgentProvider from '@archon/core/services/provider-admission' so provider concurrency caps apply.",
          })),
        },
      ],
    },
  },

  // The console owns its API and reactive state instead of growing a second
  // application data layer beside its skills and cache.
  {
    files: ['packages/web/src/experiments/console/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tanstack/react-query'],
              message: 'The console uses its own reactive store (store/cache.ts).',
            },
          ],
        },
      ],
    },
  }
);
