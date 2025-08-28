/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import os from 'os'

export default defineConfig({
  plugins: [react()],
  test: {
    // Ultra-fast configuration for development
    globals: true,
    environment: 'jsdom',
    setupFiles: './test/setup.ts',
    
    // Run only essential tests
    include: [
      'test/components.test.tsx',
      'test/config/api.test.ts',
      'test/services/projectService.test.ts'
    ],
    exclude: [
      'node_modules', 
      'dist', 
      '.git', 
      '.cache',
      '**/integration.test.*',
      '**/e2e.test.*',
      'test/user_flows.test.tsx', // Skip slower integration tests
      'test/errors.test.tsx'       // Skip slower error tests
    ],
    
    // Maximum parallelism
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: Math.min(os.cpus().length, 8),
        minThreads: 2,
        useAtomics: true
      }
    },
    
    // Minimal reporting for speed
    reporters: ['basic'],
    
    // Aggressive timeouts
    testTimeout: 5000,  // 5 seconds max
    hookTimeout: 3000,  // 3 seconds for setup/teardown
    
    // No isolation for maximum speed (trade safety for speed)
    isolate: false,
    
    // Disable coverage for speed
    coverage: {
      enabled: false
    },
    
    // Optimized environment
    env: {
      NODE_ENV: 'test',
      VITE_API_URL: 'http://localhost:8181',
      VITE_TEST_MODE: 'true',
      // Disable slow features
      VITE_DISABLE_ANIMATIONS: 'true',
      VITE_DISABLE_LAZY_LOADING: 'true'
    },
    
    // No retries for fast feedback
    retry: 0,
    
    // Maximum concurrency
    maxConcurrency: os.cpus().length,
    
    // Disable browser mode
    browser: {
      enabled: false
    },
    
    // Minimal logging
    silent: false,
    logHeapUsage: false,
    
    // Fast timers
    fakeTimers: {
      toFake: ['setTimeout', 'clearTimeout']
    }
  },
  
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  
  // Optimize for testing speed
  server: {
    hmr: false,
    preTransformRequests: false
  },
  
  build: {
    minify: false,
    sourcemap: false,
    target: 'esnext'
  },
  
  // Aggressive dependency pre-bundling
  optimizeDeps: {
    include: [
      '@testing-library/react',
      '@testing-library/jest-dom',
      '@testing-library/user-event',
      'vitest',
      'react',
      'react-dom'
    ],
    exclude: ['@milkdown/crepe', '@milkdown/kit']
  }
})