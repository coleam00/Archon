module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: [
    'dist', 
    '.eslintrc.cjs', 
    'public',
    '__mocks__',
    '*.config.js',
    '*.config.ts',
    'coverage',
    'node_modules',
    'src/features/**'  // Biome handles this directory
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['react-refresh'],
  rules: {
    /**
     * LINTING STRATEGY FOR ALPHA DEVELOPMENT:
     * 
     * Development: Warnings don't block local development, allowing rapid iteration
     * CI/PR: Run with --max-warnings 0 to treat warnings as errors before merge
     * 
     * Philosophy:
     * - Strict typing where it helps AI assistants (Claude Code, Copilot, etc.)
     * - Pragmatic flexibility for alpha-stage rapid development
     * - Console.log allowed locally but caught in CI
     * - Progressive enhancement: stricter rules in /features (new code) vs /components (legacy)
     */

    // React Refresh
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    
    // TypeScript - Pragmatic strictness for AI-assisted development
    '@typescript-eslint/no-explicit-any': 'warn', // Visible but won't block development
    '@typescript-eslint/no-non-null-assertion': 'warn', // Allow when developer is certain
    '@typescript-eslint/no-empty-function': 'warn', // Sometimes needed for placeholders
    '@typescript-eslint/ban-types': 'error', // Keep strict - prevents real issues
    
    // Help AI assistants understand code intent
    '@typescript-eslint/explicit-function-return-type': ['warn', {
      allowExpressions: true,
      allowTypedFunctionExpressions: true,
      allowHigherOrderFunctions: true,
      allowDirectConstAssertionInArrowFunctions: true,
    }],
    
    // Better TypeScript patterns
    '@typescript-eslint/prefer-as-const': 'error',
    
    // Variable and import management - strict with escape hatches
    '@typescript-eslint/no-unused-vars': ['error', { 
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      ignoreRestSiblings: true,
      destructuredArrayIgnorePattern: '^_'
    }],
    
    // React hooks - warn to allow intentional omissions during development
    'react-hooks/exhaustive-deps': 'warn',
    
    // Console usage - warn locally, CI treats as error
    'no-console': ['warn', { allow: ['error', 'warn'] }], // console.log caught but not blocking
    
    // General code quality
    'prefer-const': 'error',
    'no-var': 'error',
    'no-constant-condition': 'error',
    'no-debugger': 'warn', // Warn in dev, error in CI
    'no-alert': 'error',
    
    // Disable rules that conflict with TypeScript
    'no-undef': 'off', // TypeScript handles this better
    'no-unused-vars': 'off', // Use @typescript-eslint/no-unused-vars instead
  },
  
  // Override rules for specific file types and directories
  overrides: [
    {
      // Stricter rules for new vertical slice architecture
      files: ['src/features/**/*.{ts,tsx}'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'error', // No any in new code
        '@typescript-eslint/explicit-function-return-type': ['error', {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
        }],
        'no-console': ['error', { allow: ['error', 'warn'] }], // Stricter console usage
      }
    },
    {
      // More lenient for legacy components being migrated
      files: ['src/components/**/*.{ts,tsx}', 'src/services/**/*.{ts,tsx}'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'warn', // Still visible during migration
        '@typescript-eslint/explicit-function-return-type': 'off', // Not required for legacy
        'no-console': 'warn', // Warn during migration
      }
    },
    {
      // Test files - most lenient but still helpful
      files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', 'test/**/*'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'warn', // OK in tests but still visible
        '@typescript-eslint/no-non-null-assertion': 'off', // Fine in tests
        '@typescript-eslint/no-empty-function': 'off', // Mock functions need this
        '@typescript-eslint/explicit-function-return-type': 'off',
        'no-console': 'off', // Debugging in tests is fine
      }
    }
  ]
};