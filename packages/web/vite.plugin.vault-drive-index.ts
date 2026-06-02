import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Vite plugin: regenerate `src/lib/drive-index.generated.json` whenever a
 * drive-index file changes in the second-brain vault.
 *
 * Mirrors vite.plugin.vault-contacts.ts. The drive-index files are written
 * by ~/.hermes/scripts/drive-index-snapshot.py on an hourly cron. When a
 * folder's content changes in Drive, the snapshot script rewrites its .md
 * here, which fires this plugin's chokidar watcher, which reruns the build
 * script, which regenerates the JSON, which Vite HMR pushes to the browser.
 *
 * End-to-end latency: Drive change -> cron tick (worst case 60min) ->
 * snapshot write (~5s) -> plugin rebuild (~100ms) -> Vite HMR (~50ms).
 */
export function vaultDriveIndexPlugin(): Plugin {
  let configRoot = '';
  let driveIndexDir = '';
  let buildScript = '';
  let resolved = false;

  let debounceTimer: NodeJS.Timeout | null = null;

  const regenerate = (reason: string): void => {
    const t0 = Date.now();
    const result = spawnSync('python3', [buildScript], {
      cwd: path.dirname(buildScript),
      encoding: 'utf-8',
      timeout: 10_000,
    });
    if (result.error) {
      console.warn(`[vault-drive-index] build failed (${reason}):`, result.error.message);
      return;
    }
    if (result.status !== 0) {
      console.warn(
        `[vault-drive-index] build exited ${result.status} (${reason}):`,
        (result.stderr || result.stdout || '').trim().slice(0, 500)
      );
      return;
    }
    const elapsed = Date.now() - t0;
    const summary = (result.stdout || '').trim().split('\n')[0] || 'rebuilt';
    console.log(`[vault-drive-index] ${summary} (${elapsed}ms, ${reason})`);
  };

  const scheduleRegen = (reason: string): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => regenerate(reason), 250);
  };

  return {
    name: 'vault-drive-index',
    apply: 'serve',

    configResolved(config): void {
      configRoot = config.root;
      const archonRoot = path.resolve(configRoot, '..', '..');
      driveIndexDir = path.resolve(
        archonRoot,
        '..',
        'second-brain',
        'resources',
        'drive-index'
      );
      buildScript = path.resolve(archonRoot, 'scripts', 'build-drive-index-json.py');
      resolved = true;

      if (!existsSync(driveIndexDir)) {
        console.warn(`[vault-drive-index] drive-index dir not found: ${driveIndexDir}`);
      }
      if (!existsSync(buildScript)) {
        console.warn(`[vault-drive-index] build script not found: ${buildScript}`);
      }
    },

    configureServer(server: ViteDevServer): void {
      if (!resolved) {
        console.warn('[vault-drive-index] paths not resolved, skipping watcher setup');
        return;
      }

      server.watcher.add(driveIndexDir);
      regenerate('startup');

      const onChange = (filepath: string): void => {
        if (!filepath.startsWith(driveIndexDir)) return;
        if (!filepath.endsWith('.md')) return;
        // Note: we DO want to watch _root.md (loose top-level files), so
        // don't skip _-prefix files the way contacts does. We skip only
        // sidecar files.
        const base = path.basename(filepath);
        if (base.endsWith('.sidecar.md')) return;
        scheduleRegen(path.relative(driveIndexDir, filepath));
      };

      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);

      console.log(`[vault-drive-index] watching ${driveIndexDir}`);
      console.log(`[vault-drive-index] build script: ${buildScript}`);
    },
  };
}
