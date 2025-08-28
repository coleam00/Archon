/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import os from 'os'

export default defineConfig({
  plugins: [react()],
  test: {
    // Performance optimizations
    globals: true,
    environment: 'jsdom',
    setupFiles: './test/setup.ts',
    
    // Optimized test discovery
    include: [
      'test/components.test.tsx',
      'test/pages.test.tsx', 
      'test/user_flows.test.tsx',
      'test/errors.test.tsx',
      'test/services/projectService.test.ts',
      'test/components/project-tasks/DocsTab.integration.test.tsx',
      'test/config/api.test.ts'
    ],
    exclude: [
      'node_modules', 
      'dist', 
      '.git', 
      '.cache', 
      'test.backup', 
      '*.backup/**', 
      'test-backups',
      'coverage/**',
      '**/*.stories.*',
      '**/*.story.*',
      '**/node_modules/**'
    ],
    
    // Parallel execution
    pool: 'threads',
    poolOptions: {
      threads: {
        // Use available CPU cores with limit
        maxThreads: process.env.CI ? 2 : Math.min(os.cpus().length, 4),
        minThreads: 1,
        // Optimize for faster tests
        useAtomics: true
      }
    },
    
    // Optimized reporting
    reporters: [
      'default',
      'json',
      ...(process.env.CI ? ['junit'] : [])
    ],
    outputFile: { 
      json: './public/test-results/test-results.json',
      ...(process.env.CI ? { junit: './public/test-results/junit.xml' } : {})
    },
    
    // Timeout optimizations
    testTimeout: process.env.CI ? 30000 : 10000,
    hookTimeout: process.env.CI ? 20000 : 10000,
    
    // Test isolation
    isolate: true,
    
    // Memory and performance optimizations
    fakeTimers: {
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    },
    
    // Optimized coverage configuration
    coverage: {
      provider: 'v8',
      // Optimize coverage collection
      clean: true,
      cleanOnRerun: true,
      reportOnFailure: true,
      
      // Efficient reporting
      reporter: [
        'text-summary',
        'json-summary',
        ...(process.env.CI ? ['lcov', 'cobertura'] : ['html']),
        'json'
      ],
      
      reportsDirectory: './public/test-results/coverage',
      
      // Performance-focused exclusions
      exclude: [
        'node_modules/',
        'test/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/*.config.{js,ts}',
        '**/mockData.ts',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
        'src/env.d.ts',
        'coverage/**',
        'dist/**',
        'public/**',
        '**/*.stories.*',
        '**/*.story.*',
        '**/mocks/**',
        '**/__mocks__/**',
        '**/test-utils/**'
      ],
      
      include: [
        'src/**/*.{ts,tsx}',
        '!src/**/*.d.ts'
      ],
      
      // Performance thresholds
      thresholds: {
        global: {
          // Set realistic thresholds to avoid blocking development
          statements: process.env.CI ? 50 : 0,
          branches: process.env.CI ? 50 : 0,
          functions: process.env.CI ? 50 : 0,
          lines: process.env.CI ? 50 : 0
        }
      },
      
      // Optimize coverage collection
      skipFull: true,
      perFile: false,
      100: false
    },
    
    // Environment optimizations
    env: {
      NODE_ENV: 'test',
      VITE_API_URL: 'http://localhost:8181',
      // Speed up tests by reducing delays
      VITE_TEST_MODE: 'true'
    },
    
    // Watch mode optimizations
    watch: {
      ignore: [
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
        '**/.git/**'
      ]
    },
    
    // Memory management
    maxConcurrency: process.env.CI ? 2 : 5,
    
    // Browser optimizations for jsdom
    browser: {
      enabled: false // Disable browser mode for speed
    },
    
    // Retry configuration
    retry: process.env.CI ? 2 : 0,
    
    // Logging optimization
    logHeapUsage: process.env.NODE_ENV === 'development'
  },
  
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  
  // Development server optimizations for testing
  server: {
    // Faster builds during testing
    hmr: false
  },
  
  // Build optimizations for test builds
  build: {
    // Optimize build for tests
    minify: false,
    sourcemap: false
  },
  
  // Dependency optimization
  optimizeDeps: {
    // Pre-bundle common test dependencies
    include: [
      '@testing-library/react',
      '@testing-library/jest-dom',
      '@testing-library/user-event',
      'vitest'
    ],
    // Exclude from optimization to speed up dev server start
    exclude: ['@milkdown/crepe', '@milkdown/kit']
  }
}) 