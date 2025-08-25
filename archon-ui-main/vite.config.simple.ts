/// <reference types="vitest" />
import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import type { ConfigEnv, UserConfig } from 'vite';

// Simplified Vite config for both development and production
export default defineConfig(({ mode }: ConfigEnv): UserConfig => {
  // Load environment variables
  const env = loadEnv(mode, process.cwd(), '');
  
  // Get host and port from environment variables or use defaults
  const host = process.env.HOST || 'localhost';
  const port = process.env.ARCHON_SERVER_PORT || env.ARCHON_SERVER_PORT || '8181';
  
  return {
    plugins: [react()],
    
    // Only configure server for development
    server: mode === 'development' ? {
      host: '0.0.0.0',
      port: parseInt(process.env.ARCHON_UI_PORT || env.ARCHON_UI_PORT || '3737'),
      strictPort: true,
      allowedHosts: [env.HOST, 'localhost', '127.0.0.1'],
      proxy: {
        '/api': {
          target: `http://${host}:${port}`,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
        '/socket.io': {
          target: `http://${host}:${port}`,
          changeOrigin: true,
          ws: true
        }
      },
    } : undefined,
    
    define: {
      'import.meta.env.VITE_HOST': JSON.stringify(host),
      'import.meta.env.VITE_PORT': JSON.stringify(port),
      'import.meta.env.PROD': env.PROD === 'true',
    },
    
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './test/setup.ts',
      css: true,
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/cypress/**',
        '**/.{idea,git,cache,output,temp}/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
        '**/*.test.{ts,tsx}',
      ],
      env: {
        VITE_HOST: host,
        VITE_PORT: port,
      },
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
        exclude: [
          'node_modules/',
          'test/',
          '**/*.d.ts',
          '**/*.config.*',
          '**/mockData.ts',
          '**/*.test.{ts,tsx}',
        ],
      }
    }
  };
});