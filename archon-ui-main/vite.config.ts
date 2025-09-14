/// <reference types="vitest" />
import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { exec } from 'child_process';
import { readFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import type { ConfigEnv, UserConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig(({ mode }: ConfigEnv): UserConfig => {
  // Load environment variables
  const env = loadEnv(mode, process.cwd(), '');
  
  // Azure Container Apps configuration
  // Use environment variables for backend URL, with fallbacks
  const backendUrl = env.VITE_API_URL || 
                     process.env.VITE_API_URL || 
                     'http://localhost:8181';
  
  // MCP Server URL for Azure Container Apps
  const mcpServerUrl = env.VITE_MCP_SERVER_URL || 
                       process.env.VITE_MCP_SERVER_URL || 
                       'https://archon-mcp.purplemoss-0b16bcfe.eastus.azurecontainerapps.io';
  
  console.log('[VITE CONFIG] Backend URL:', backendUrl);
  console.log('[VITE CONFIG] MCP Server URL:', mcpServerUrl);
  console.log('[VITE CONFIG] Using environment variable VITE_API_URL:', env.VITE_API_URL);
  console.log('[VITE CONFIG] Using environment variable VITE_MCP_SERVER_URL:', env.VITE_MCP_SERVER_URL);
  
  return {
    plugins: [
      react(),
      // Custom plugin to add test endpoint
      {
        name: 'test-runner',
        configureServer(server) {
          // Serve coverage directory statically
          server.middlewares.use(async (req, res, next) => {
            if (req.url?.startsWith('/coverage/')) {
              const filePath = path.join(process.cwd(), req.url);
              console.log('[VITE] Serving coverage file:', filePath);
              try {
                const data = await readFile(filePath);
                const contentType = req.url.endsWith('.json') ? 'application/json' : 
                                  req.url.endsWith('.html') ? 'text/html' : 'text/plain';
                res.setHeader('Content-Type', contentType);
                res.end(data);
              } catch (err) {
                console.log('[VITE] Coverage file not found:', filePath);
                res.statusCode = 404;
                res.end('Not found');
              }
            } else {
              next();
            }
          });
          
          // Test execution endpoint (basic tests)
          server.middlewares.use('/api/run-tests', (req: any, res: any) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }

            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type',
            });

            // Run vitest with proper configuration (includes JSON reporter)
            const testProcess = exec('npm run test -- --run', {
              cwd: process.cwd()
            });

            testProcess.stdout?.on('data', (data) => {
              const text = data.toString();
              // Split by newlines but preserve empty lines for better formatting
              const lines = text.split('\n');
              
              lines.forEach((line: string) => {
                // Send all lines including empty ones for proper formatting
                res.write(`data: ${JSON.stringify({ type: 'output', message: line, timestamp: new Date().toISOString() })}\n\n`);
              });
              
              // Flush the response to ensure immediate delivery
              if (res.flushHeaders) {
                res.flushHeaders();
              }
            });

            testProcess.stderr?.on('data', (data) => {
              const lines = data.toString().split('\n').filter((line: string) => line.trim());
              lines.forEach((line: string) => {
                // Strip ANSI escape codes
                const cleanLine = line.replace(/\\x1b\[[0-9;]*m/g, '');
                res.write(`data: ${JSON.stringify({ type: 'output', message: cleanLine, timestamp: new Date().toISOString() })}\n\n`);
              });
            });

            testProcess.on('close', (code) => {
              res.write(`data: ${JSON.stringify({ 
                type: 'completed', 
                exit_code: code, 
                status: code === 0 ? 'completed' : 'failed',
                message: code === 0 ? 'Tests completed and results generated!' : 'Tests failed',
                timestamp: new Date().toISOString() 
              })}\n\n`);
              res.end();
            });

            testProcess.on('error', (error) => {
              res.write(`data: ${JSON.stringify({ 
                type: 'error', 
                message: error.message, 
                timestamp: new Date().toISOString() 
              })}\n\n`);
              res.end();
            });

            req.on('close', () => {
              testProcess.kill();
            });
          });

          // Test execution with coverage endpoint
          server.middlewares.use('/api/run-tests-with-coverage', (req: any, res: any) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }

            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type',
            });

            // Run vitest with coverage using the proper script (now includes both default and JSON reporters)
            // Add CI=true to get cleaner output without HTML dumps
            // Override the reporter to use verbose for better streaming output
            // When running in Docker, we need to ensure the test results directory exists
            const testResultsDir = path.join(process.cwd(), 'public', 'test-results');
            if (!existsSync(testResultsDir)) {
              mkdirSync(testResultsDir, { recursive: true });
            }
            
            const testProcess = exec('npm run test:coverage:stream', {
              cwd: process.cwd(),
              env: { 
                ...process.env, 
                FORCE_COLOR: '1', 
                CI: 'true',
                NODE_ENV: 'test' 
              } // Enable color output and CI mode for cleaner output
            });

            testProcess.stdout?.on('data', (data) => {
              const text = data.toString();
              // Split by newlines but preserve empty lines for better formatting
              const lines = text.split('\n');
              
              lines.forEach((line: string) => {
                // Strip ANSI escape codes to get clean text
                const cleanLine = line.replace(/\\x1b\[[0-9;]*m/g, '');
                
                // Send all lines for verbose reporter output
                res.write(`data: ${JSON.stringify({ type: 'output', message: cleanLine, timestamp: new Date().toISOString() })}\n\n`);
              });
              
              // Flush the response to ensure immediate delivery
              if (res.flushHeaders) {
                res.flushHeaders();
              }
            });

            testProcess.stderr?.on('data', (data) => {
              const lines = data.toString().split('\n').filter((line: string) => line.trim());
              lines.forEach((line: string) => {
                // Strip ANSI escape codes
                const cleanLine = line.replace(/\\x1b\[[0-9;]*m/g, '');
                res.write(`data: ${JSON.stringify({ type: 'output', message: cleanLine, timestamp: new Date().toISOString() })}\n\n`);
              });
            });

            testProcess.on('close', (code) => {
              res.write(`data: ${JSON.stringify({ 
                type: 'completed', 
                exit_code: code, 
                status: code === 0 ? 'completed' : 'failed',
                message: code === 0 ? 'Tests completed with coverage and results generated!' : 'Tests failed',
                timestamp: new Date().toISOString() 
              })}\n\n`);
              res.end();
            });

            testProcess.on('error', (error) => {
              res.write(`data: ${JSON.stringify({ 
                type: 'error', 
                message: error.message, 
                timestamp: new Date().toISOString() 
              })}\n\n`);
              res.end();
            });

            req.on('close', () => {
              testProcess.kill();
            });
          });

          // Coverage generation endpoint
          server.middlewares.use('/api/generate-coverage', (req: any, res: any) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }

            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type',
            });

            res.write(`data: ${JSON.stringify({ 
              type: 'status', 
              message: 'Starting coverage generation...', 
              timestamp: new Date().toISOString() 
            })}\n\n`);

            // Run coverage generation
            const coverageProcess = exec('npm run test:coverage', {
              cwd: process.cwd()
            });

            coverageProcess.stdout?.on('data', (data) => {
              const lines = data.toString().split('\n').filter((line: string) => line.trim());
              lines.forEach((line: string) => {
                res.write(`data: ${JSON.stringify({ type: 'output', message: line, timestamp: new Date().toISOString() })}\n\n`);
              });
            });

            coverageProcess.stderr?.on('data', (data) => {
              const lines = data.toString().split('\n').filter((line: string) => line.trim());
              lines.forEach((line: string) => {
                res.write(`data: ${JSON.stringify({ type: 'output', message: line, timestamp: new Date().toISOString() })}\n\n`);
              });
            });

            coverageProcess.on('close', (code) => {
              res.write(`data: ${JSON.stringify({ 
                type: 'completed', 
                exit_code: code, 
                status: code === 0 ? 'completed' : 'failed',
                message: code === 0 ? 'Coverage report generated successfully!' : 'Coverage generation failed',
                timestamp: new Date().toISOString() 
              })}\n\n`);
              res.end();
            });

            coverageProcess.on('error', (error) => {
              res.write(`data: ${JSON.stringify({ 
                type: 'error', 
                message: error.message, 
                timestamp: new Date().toISOString() 
              })}\n\n`);
              res.end();
            });

            req.on('close', () => {
              coverageProcess.kill();
            });
          });
        }
      }
    ],
    server: {
      host: '0.0.0.0', // Listen on all network interfaces with explicit IP
      port: 5173, // Match the port expected in Docker
      strictPort: true, // Exit if port is in use
      proxy: {
        '/api': {
          target: backendUrl,
          changeOrigin: true,
          secure: true, // Use true for HTTPS backends
          ws: true,
          configure: (proxy, options) => {
            proxy.on('error', (err, req, res) => {
              console.log('VITE PROXY ERROR:', err.message);
              console.log('VITE PROXY ERROR Target:', backendUrl);
              console.log('VITE PROXY ERROR Request:', req.url);
            });
            proxy.on('proxyReq', (proxyReq, req, res) => {
              console.log('VITE PROXY Forwarding:', req.method, req.url, 'to', `${backendUrl}${req.url}`);
            });
          }
        },
        // Socket.IO specific proxy configuration
        '/socket.io': {
          target: backendUrl,
          changeOrigin: true,
          secure: true,
          ws: true
        },
        // Health check proxy
        '/health': {
          target: backendUrl,
          changeOrigin: true,
          secure: true
        },
        // MCP Server proxy for Azure Container Apps
        '/mcp': {
          target: mcpServerUrl,
          changeOrigin: true,
          secure: true,
          ws: true,
          configure: (proxy, options) => {
            proxy.on('error', (err, req, res) => {
              console.log('VITE MCP PROXY ERROR:', err.message);
              console.log('VITE MCP PROXY ERROR Target:', mcpServerUrl);
              console.log('VITE MCP PROXY ERROR Request:', req.url);
            });
            proxy.on('proxyReq', (proxyReq, req, res) => {
              console.log('VITE MCP PROXY Forwarding:', req.method, req.url, 'to', `${mcpServerUrl}${req.url}`);
            });
          }
        }
      },
    },
    define: {
      'import.meta.env.VITE_BACKEND_URL': JSON.stringify(backendUrl),
      'import.meta.env.VITE_MCP_SERVER_URL': JSON.stringify(mcpServerUrl),
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
        VITE_BACKEND_URL: backendUrl,
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