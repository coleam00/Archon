/// <reference types="vitest" />
import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { spawn, type ChildProcess } from 'child_process';
import { readFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import type { ConfigEnv, UserConfig } from 'vite';

// Shared ANSI escape sequence regex for consistent stripping (built to avoid linter control-char rule)
const ANSI_REGEX = new RegExp('\u001B\[[0-9;?]*[ -/]*[@-~]', 'g');

function killProcessTree(cp: ChildProcess) {
  if (!cp || typeof cp.pid !== 'number') return;
  try {
    if (process.platform === 'win32') {
      // /T kills the whole tree, /F forces
      const killer = spawn('taskkill', ['/PID', String(cp.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => {/* swallow */});
    } else {
      // Kill the process group if detached, else the pid
      try { process.kill(-cp.pid, 'SIGTERM'); } catch { process.kill(cp.pid, 'SIGTERM'); }
    }
  } catch { /* swallow */ }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }: ConfigEnv): UserConfig => {
  // Load environment variables
  const env = loadEnv(mode, process.cwd(), '');
  
  // Get host and port from environment variables or use defaults
  // For internal Docker communication, use the service name
  // For external access, use the HOST from environment
  const isDocker = process.env.DOCKER_ENV === 'true' || existsSync('/.dockerenv');
  const internalHost = process.env.ARCHON_SERVER_INTERNAL_HOST || env.ARCHON_SERVER_INTERNAL_HOST || 'archon-server';  // Docker service name for internal communication
  // Explicit backend host to avoid accidentally using HOST=0.0.0.0
  const serverHost = process.env.ARCHON_SERVER_HOST || env.ARCHON_SERVER_HOST || 'localhost';
  const host = isDocker ? internalHost : serverHost;
  const serverPort = process.env.ARCHON_SERVER_PORT || env.ARCHON_SERVER_PORT || '8181';

  // UI port configuration - use 3737 in Docker to match compose,
  // or ARCHON_UI_PORT for local development
  const uiPort = isDocker ? 3737 : parseInt(process.env.ARCHON_UI_PORT || env.ARCHON_UI_PORT || '3737', 10);
  
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
              // Security: explicit opt-in required to expose coverage artifacts
              if (process.env.VITE_ENABLE_TEST_API !== 'true') {
                res.statusCode = 403;
                res.end('Coverage browsing disabled');
                return;
              }
              // Only allow safe methods for static assets
              if (req.method && !['GET', 'HEAD'].includes(req.method)) {
                res.statusCode = 405;
                res.end('Method not allowed');
                return;
              }
              
              // Serve only from the local ./coverage directory and prevent traversal
              const coverageRoot = path.resolve(process.cwd(), 'coverage');
              const rawUrl = req.url ?? '';
              
              // Strip the leading route prefix and decode URL safely
              let rel: string;
              try {
                rel = decodeURIComponent(rawUrl.replace(/^\/coverage\/?/, ''));
                // Default to index.html for directory access
                if (!rel || rel === '/') rel = 'index.html';
                // Reject requests with NUL bytes
                if (rel.includes('\0')) {
                  res.statusCode = 400;
                  res.end('Bad request');
                  return;
                }
              } catch {
                res.statusCode = 400;
                res.end('Bad request');
                return;
              }
              
              // Normalize the relative path
              const normalizedRel = path.normalize(rel);
              // Resolve against coverage root
              const resolvedPath = path.resolve(coverageRoot, normalizedRel);
              // Ensure the resolved path stays within coverageRoot
              const coverageRootWithSep = coverageRoot.endsWith(path.sep) ? coverageRoot : coverageRoot + path.sep;
              if (!(resolvedPath === coverageRoot || resolvedPath.startsWith(coverageRootWithSep))) {
                res.statusCode = 400;
                res.end('Bad request');
                return;
              }
              
              console.log('[VITE] Serving coverage file:', rel || 'index');
              try {
                const data = await readFile(resolvedPath);
                const ext = path.extname(resolvedPath).toLowerCase();
                const contentType =
                  ext === '.json' ? 'application/json' :
                  ext === '.map'  ? 'application/json' :
                  ext === '.html' ? 'text/html; charset=utf-8' :
                  ext === '.css'  ? 'text/css; charset=utf-8' :
                  ext === '.js'   ? 'text/javascript; charset=utf-8' :
                  ext === '.mjs'  ? 'text/javascript; charset=utf-8' :
                  ext === '.xml'  ? 'application/xml' :
                  ext === '.svg'  ? 'image/svg+xml' :
                  ext === '.txt'  ? 'text/plain; charset=utf-8' :
                  ext === '.ico'  ? 'image/x-icon' :
                  'application/octet-stream';
                res.setHeader('Content-Type', contentType);
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.end(data);
              } catch (err) {
                console.log('[VITE] Coverage file not found:', rel || 'index');
                res.statusCode = 404;
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
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

            // Security: Explicit opt-in required for test endpoints in any environment
            if (process.env.VITE_ENABLE_TEST_API !== 'true') {
              res.statusCode = 403;
              res.end('Test API disabled for security');
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
            const testProcess = spawn('npm', ['run', 'test', '--', '--run'], {
              cwd: process.cwd(),
              stdio: ['ignore', 'pipe', 'pipe'],
              shell: process.platform === 'win32', // ensure npm resolution on Windows
              detached: process.platform !== 'win32',
              windowsHide: true,
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
                const cleanLine = line.replace(ANSI_REGEX, '');
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

            req.on('close', () => killProcessTree(testProcess));
          });

          // Test execution with coverage endpoint
          server.middlewares.use('/api/run-tests-with-coverage', (req: any, res: any) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }

            // Security: Explicit opt-in required for test endpoints in any environment
            if (process.env.VITE_ENABLE_TEST_API !== 'true') {
              res.statusCode = 403;
              res.end('Test API disabled for security');
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
            const testResultsDir = path.resolve(process.cwd(), 'public', 'test-results');
            if (!existsSync(testResultsDir)) {
              mkdirSync(testResultsDir, { recursive: true });
            }
            
            const testProcess = spawn('npm', ['run', 'test:coverage:stream'], {
              cwd: process.cwd(),
              env: {
                ...process.env, 
                FORCE_COLOR: '1', 
                CI: 'true',
                NODE_ENV: 'test' 
              }, // Enable color output and CI mode for cleaner output
              stdio: ['ignore', 'pipe', 'pipe'],
              shell: process.platform === 'win32',
              detached: process.platform !== 'win32',
              windowsHide: true,
            });

            testProcess.stdout?.on('data', (data) => {
              const text = data.toString();
              // Split by newlines but preserve empty lines for better formatting
              const lines = text.split('\n');
              
              lines.forEach((line: string) => {
                // Strip ANSI escape codes to get clean text
                const cleanLine = line.replace(ANSI_REGEX, '');
                
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
                const cleanLine = line.replace(ANSI_REGEX, '');
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

            req.on('close', () => killProcessTree(testProcess));
          });

          // Coverage generation endpoint
          server.middlewares.use('/api/generate-coverage', (req: any, res: any) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }

            // Security: Explicit opt-in required for test endpoints in any environment
            if (process.env.VITE_ENABLE_TEST_API !== 'true') {
              res.statusCode = 403;
              res.end('Test API disabled for security');
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
            const coverageProcess = spawn('npm', ['run', 'test:coverage'], {
              cwd: process.cwd(),
              stdio: ['ignore', 'pipe', 'pipe'],
              shell: process.platform === 'win32',
              detached: process.platform !== 'win32',
              windowsHide: true,
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

            req.on('close', () => killProcessTree(coverageProcess));
          });
        }
      }
    ],
    server: {
      host: '0.0.0.0', // Listen on all network interfaces with explicit IP
      port: uiPort, // Use dynamic port based on environment
      strictPort: true, // Exit if port is in use
      proxy: {
        '/api': {
          target: `http://${host}:${serverPort}`,
          changeOrigin: true,
          secure: false,
          ws: true,
          configure: (proxy) => {
            proxy.on('error', (err, req, res) => {
              if (process.env.VITE_DEBUG_PROXY === '1') console.log('🚨 [VITE PROXY ERROR]:', err.message);
              if (process.env.VITE_DEBUG_PROXY === '1') console.log('🚨 [VITE PROXY ERROR] Target:', `http://${host}:${serverPort}`);
              if (process.env.VITE_DEBUG_PROXY === '1') console.log('🚨 [VITE PROXY ERROR] Request:', req.url);
            });
            proxy.on('proxyReq', (proxyReq, req, res) => {
              if (process.env.VITE_DEBUG_PROXY === '1') console.log('🔄 [VITE PROXY] Forwarding:', req.method, req.url, 'to', `http://${host}:${serverPort}${req.url}`);
            });
          }
        },
        // Socket.IO specific proxy configuration
        '/socket.io': {
          target: `http://${host}:${serverPort}`,
          changeOrigin: true,
          ws: true
        }
      },
    },
    define: {
      'import.meta.env.VITE_HOST': JSON.stringify(host),
      'import.meta.env.VITE_PORT': JSON.stringify(serverPort),
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
      include: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'test/**/*.{test,spec}.{ts,tsx}'
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/cypress/**',
        '**/.{idea,git,cache,output,temp}/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
      ],
      env: {
        VITE_HOST: host,
        VITE_PORT: serverPort,
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
