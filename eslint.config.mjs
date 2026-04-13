import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

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
      'worktrees/**',
      '.claude/worktrees/**',
      '.claude/skills/**',
      '**/*.js',
      '*.mjs',
      '**/*.test.ts',
      '**/src/test/**', // Test helper files (mock factories, fixtures)
      '*.d.ts', // Root-level declaration files (not in tsconfig project scope)
      '**/*.generated.d.ts', // Auto-generated declaration files (e.g. openapi-typescript output)
      'packages/web/vite.config.ts', // Vite config doesn't need type-checked linting
      'packages/web/components.json',
      'packages/web/src/components/ui/**', // shadcn/ui auto-generated components
      'packages/web/src/lib/utils.ts', // shadcn/ui utility file
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
    files: ['packages/*/src/**/*.{ts,tsx}'],
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
  }
);
