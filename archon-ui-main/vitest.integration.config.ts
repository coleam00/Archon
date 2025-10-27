/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './tests/integration/setup.ts', // Use integration-specific setup
    include: [
      'tests/integration/**/*.test.{ts,tsx}',
      'tests/integration/**/*.spec.{ts,tsx}'
    ],
    exclude: ['node_modules', 'dist', '.git', '.cache'],
    reporters: ['dot', 'json'],
    outputFile: { 
      json: './public/test-results/integration-results.json' 
    },
    testTimeout: 30000, // 30 seconds for integration tests
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Proxy API calls to the backend for integration tests
    proxy: {
      '/api': {
        target: 'http://localhost:8181',
        changeOrigin: true,
      },
    },
  },
})