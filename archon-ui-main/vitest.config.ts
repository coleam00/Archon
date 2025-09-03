/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './test/setup.ts',
    include: [
      'test/**/*.test.{ts,tsx}',
      'test/**/*.spec.{ts,tsx}'
    ],
    exclude: ['node_modules', 'dist', '.git', '.cache', 'test.backup', '*.backup/**', 'test-backups'],
    reporters: ['dot', 'json'],
    outputFile: { 
      json: './public/test-results/test-results.json' 
    },
    testTimeout: 10000, // 10 seconds timeout
    hookTimeout: 10000, // 10 seconds for setup/teardown
    coverage: {
      provider: 'v8',
      reporter: [
        'text', 
        'text-summary', 
        'html', 
        'json', 
        'json-summary',
        'lcov'
      ],
      reportsDirectory: './public/test-results/coverage',
      clean: false, // Don't clean the directory as it may be in use
      reportOnFailure: true, // Generate coverage reports even when tests fail
      exclude: [
        'node_modules/',
        'test/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData.ts',
        '**/*.test.{ts,tsx}',
        'src/env.d.ts',
        'coverage/**',
        'dist/**',
        'public/**',
        '**/*.stories.*',
        '**/*.story.*',
      ],
      include: [
        'src/**/*.{ts,tsx}',
      ],
      thresholds: {}
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
}) 