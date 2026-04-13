import path from 'path';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Load env from repo root so ARCHON_PORT / ARCHON_VITE_PORT / PORT from .env is available
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const apiPort = env.ARCHON_PORT ?? env.PORT ?? '3090';
  const rawVitePort = env.ARCHON_VITE_PORT;
  let viteDevPort = 5173;
  if (rawVitePort) {
    const parsed = Number(rawVitePort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      console.error(
        `[archon] ARCHON_VITE_PORT="${rawVitePort}" is invalid — must be an integer 1-65535`
      );
      process.exit(1);
    }
    viteDevPort = parsed;
  }

  // Read version from root package.json
  const rootPkgPath = path.resolve(__dirname, '../../package.json');
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8')) as { version: string };
  const appVersion = rootPkg.version;

  // Get short git commit hash (fallback to 'unknown' if git unavailable)
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse --short HEAD', { cwd: path.resolve(__dirname, '../..') })
      .toString()
      .trim();
  } catch {
    // git not available in this build environment
  }

  return {
    plugins: [react(), tailwindcss()],
    define: {
      // Inject API port so browser code can access it via import.meta.env.VITE_API_PORT
      'import.meta.env.VITE_API_PORT': JSON.stringify(apiPort),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
      'import.meta.env.VITE_GIT_COMMIT': JSON.stringify(gitCommit),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
      dedupe: [
        'mdast-util-find-and-replace',
        'mdast-util-gfm-autolink-literal',
        'mdast-util-gfm',
        'remark-gfm',
      ],
    },
    server: {
      port: viteDevPort,
      ...(rawVitePort ? { strictPort: true } : {}),
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
