/// <reference types="vitest" />
import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { exec } from 'child_process';
import { readFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import type { ConfigEnv, UserConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig(({ mode }: ConfigEnv): UserConfig => {
  // Load environment variables
  const env = loadEnv(mode, process.cwd(), '');
  
  // Get host and port from environment variables or use defaults
  // For internal Docker communication, use the service name
  // For external access, use the HOST from environment
  const isDocker = process.env.DOCKER_ENV === 'true' || existsSync('/.dockerenv');
  const internalHost = 'archon-server';  // Docker service name for internal communication
  const externalHost = process.env.HOST || 'localhost';  // Host for external access
  // CRITICAL: For proxy target, always use internal host in Docker
  const proxyHost = isDocker ? internalHost : externalHost;
  const host = isDocker ? internalHost : externalHost;
  const port = process.env.ARCHON_SERVER_PORT || env.ARCHON_SERVER_PORT || '8181';
  
  return {
    plugins: [
      tailwindcss(),
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
      port: parseInt(process.env.ARCHON_UI_PORT || env.ARCHON_UI_PORT || '3737'), // Use configurable port
      strictPort: true, // Exit if port is in use
      allowedHosts: (() => {
        const defaultHosts = ['localhost', '127.0.0.1', '::1'];
        const customHosts = env.VITE_ALLOWED_HOSTS?.trim()
          ? env.VITE_ALLOWED_HOSTS.split(',').map(h => h.trim()).filter(Boolean)
          : [];
        const hostFromEnv = (process.env.HOST ?? env.HOST) && (process.env.HOST ?? env.HOST) !== 'localhost' 
          ? [process.env.HOST ?? env.HOST] 
          : [];
        return [...new Set([...defaultHosts, ...hostFromEnv, ...customHosts])];
      })(),
      proxy: (() => {
        const proxyConfig: Record<string, any> = {};
        
        // Check if agent work orders service should be enabled
        // This can be disabled via environment variable to prevent hard dependency
        const agentWorkOrdersEnabled = env.AGENT_WORK_ORDERS_ENABLED !== 'false';
        const agentWorkOrdersPort = env.AGENT_WORK_ORDERS_PORT || '8053';
        
        // Agent Work Orders API proxy (must come before general /api if enabled)
        if (agentWorkOrdersEnabled) {
          proxyConfig['/api/agent-work-orders'] = {
            target: isDocker ? `http://archon-agent-work-orders:${agentWorkOrdersPort}` : `http://localhost:${agentWorkOrdersPort}`,
          changeOrigin: true,
          secure: false,
            timeout: 10000, // 10 second timeout
            configure: (proxy: any, options: any) => {
              const targetUrl = isDocker ? `http://archon-agent-work-orders:${agentWorkOrdersPort}` : `http://localhost:${agentWorkOrdersPort}`;
              
              // Handle proxy errors (e.g., service is down)
              proxy.on('error', (err: Error, req: any, res: any) => {
              console.log('🚨 [VITE PROXY ERROR - Agent Work Orders]:', err.message);
              console.log('🚨 [VITE PROXY ERROR] Target:', targetUrl);
              console.log('🚨 [VITE PROXY ERROR] Request:', req.url);
                
                // Send proper error response instead of hanging
                if (!res.headersSent) {
                  res.writeHead(503, {
                    'Content-Type': 'application/json',
                    'X-Service-Unavailable': 'agent-work-orders'
                  });
                  res.end(JSON.stringify({
                    error: 'Service Unavailable',
                    message: 'Agent Work Orders service is not available',
                    service: 'agent-work-orders',
                    target: targetUrl
                  }));
                }
              });
              
              // Handle connection timeout
              proxy.on('proxyReq', (proxyReq: any, req: any, res: any) => {
              console.log('🔄 [VITE PROXY - Agent Work Orders] Forwarding:', req.method, req.url, 'to', `${targetUrl}${req.url}`);
                
                // Set timeout for the proxy request
                proxyReq.setTimeout(10000, () => {
                  console.log('⏱️ [VITE PROXY - Agent Work Orders] Request timeout');
                  if (!res.headersSent) {
                    res.writeHead(504, {
                      'Content-Type': 'application/json',
                      'X-Service-Unavailable': 'agent-work-orders'
                    });
                    res.end(JSON.stringify({
                      error: 'Gateway Timeout',
                      message: 'Agent Work Orders service did not respond in time',
                      service: 'agent-work-orders',
                      target: targetUrl
                    }));
                  }
                });
              });
            }
          };
        } else {
          console.log('⚠️ [VITE PROXY] Agent Work Orders proxy disabled via AGENT_WORK_ORDERS_ENABLED=false');
        }
        
        // General /api proxy (always enabled, comes after specific routes if agent work orders is enabled)
        proxyConfig['/api'] = {
          target: `http://${proxyHost}:${port}`,
          changeOrigin: true,
          secure: false,
          configure: (proxy: any, options: any) => {
            proxy.on('error', (err: Error, req: any, res: any) => {
              console.log('🚨 [VITE PROXY ERROR]:', err.message);
              console.log('🚨 [VITE PROXY ERROR] Target:', `http://${proxyHost}:${port}`);
              console.log('🚨 [VITE PROXY ERROR] Request:', req.url);
            });
            proxy.on('proxyReq', (proxyReq: any, req: any, res: any) => {
              console.log('🔄 [VITE PROXY] Forwarding:', req.method, req.url, 'to', `http://${proxyHost}:${port}${req.url}`);
            });
          }
        };
        
        // Health check endpoint proxy
        proxyConfig['/health'] = {
          target: `http://${host}:${port}`,
          changeOrigin: true,
          secure: false
        };
        
        // Socket.IO specific proxy configuration
        proxyConfig['/socket.io'] = {
          target: `http://${host}:${port}`,
          changeOrigin: true,
          ws: true
        };
        
        return proxyConfig;
      })(),
    },
    define: {
      // CRITICAL: Don't inject Docker internal hostname into the build
      // The browser can't resolve 'archon-server'
      'import.meta.env.VITE_HOST': JSON.stringify(isDocker ? 'localhost' : host),
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
      setupFiles: './tests/setup.ts',
      css: true,
      include: [
        'src/**/*.{test,spec}.{ts,tsx}',  // Tests colocated in features
        'tests/**/*.{test,spec}.{ts,tsx}'  // Tests in tests directory
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/cypress/**',
        '**/.{idea,git,cache,output,temp}/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*'
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
          'tests/',
          '**/*.d.ts',
          '**/*.config.*',
          '**/mockData.ts',
          '**/*.test.{ts,tsx}',
        ],
      }
    }
  };
});
