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
  const isDocker = process.env.DOCKER_ENV === 'true' || process.env.NODE_ENV !== 'development';
  const internalHost = 'archon-server';  // Docker service name
  const externalHost = process.env.HOST || 'localhost';
  const host = isDocker ? internalHost : externalHost;
  const port = process.env.ARCHON_SERVER_PORT || env.ARCHON_SERVER_PORT || '8181';
  
  // Build allowed hosts list including your domain
  const allowedHosts = ['localhost', '127.0.0.1'];
  if (env.HOST) allowedHosts.push(env.HOST);
  if (env.DOMAIN) allowedHosts.push(env.DOMAIN, `www.${env.DOMAIN}`);
  if (process.env.DOMAIN) allowedHosts.push(process.env.DOMAIN, `www.${process.env.DOMAIN}`);
  // Add your specific domain
  allowedHosts.push('archon.cogitia.com.es', 'www.archon.cogitia.com.es');
  
  return {
    plugins: [react()],
    
    // Always configure server (needed for Docker proxy)
    server: {
      host: '0.0.0.0',
      port: parseInt(process.env.ARCHON_UI_PORT || env.ARCHON_UI_PORT || '3737'),
      strictPort: true,
      allowedHosts: allowedHosts,
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
        },
        '/mcp': {
          target: `http://archon-mcp:8051`,
          changeOrigin: true,
          secure: false,
        }
      },
    },
    
    define: {
      'import.meta.env.VITE_HOST': JSON.stringify(host),
      'import.meta.env.VITE_PORT': JSON.stringify(port),
      'import.meta.env.ARCHON_MCP_PORT': JSON.stringify(process.env.ARCHON_MCP_PORT || env.ARCHON_MCP_PORT || '8051'),
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