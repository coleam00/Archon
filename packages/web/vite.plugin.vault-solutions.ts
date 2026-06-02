import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Vite plugin: regenerate `src/lib/solutions.generated.json` whenever a
 * partner/solution MOC changes in the second-brain vault.
 *
 * Mirrors vite.plugin.vault-drive-index.ts and vite.plugin.vault-contacts.ts.
 * Watches second-brain/partners/ recursively. Debounced 250ms.
 */
export function vaultSolutionsPlugin(): Plugin {
  let configRoot = '';
  let partnersDir = '';
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
      console.warn(`[vault-solutions] build failed (${reason}):`, result.error.message);
      return;
    }
    if (result.status !== 0) {
      console.warn(
        `[vault-solutions] build exited ${result.status} (${reason}):`,
        (result.stderr || result.stdout || '').trim().slice(0, 500)
      );
      return;
    }
    const elapsed = Date.now() - t0;
    const summary = (result.stdout || '').trim().split('\n')[0] || 'rebuilt';
    console.log(`[vault-solutions] ${summary} (${elapsed}ms, ${reason})`);
  };

  const scheduleRegen = (reason: string): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => regenerate(reason), 250);
  };

  return {
    name: 'vault-solutions',
    apply: 'serve',

    configResolved(config): void {
      configRoot = config.root;
      const archonRoot = path.resolve(configRoot, '..', '..');
      partnersDir = path.resolve(archonRoot, '..', 'second-brain', 'partners');
      buildScript = path.resolve(archonRoot, 'scripts', 'build-solutions-json.py');
      resolved = true;

      if (!existsSync(partnersDir)) {
        console.warn(`[vault-solutions] partners dir not found: ${partnersDir}`);
      }
      if (!existsSync(buildScript)) {
        console.warn(`[vault-solutions] build script not found: ${buildScript}`);
      }
    },

    configureServer(server: ViteDevServer): void {
      if (!resolved) {
        console.warn('[vault-solutions] paths not resolved, skipping watcher setup');
        return;
      }

      server.watcher.add(partnersDir);
      regenerate('startup');

      const onChange = (filepath: string): void => {
        if (!filepath.startsWith(partnersDir)) return;
        if (!filepath.endsWith('.md')) return;
        // Skip OLD archived files
        const base = path.basename(filepath);
        if (base.endsWith('-OLD.md')) return;
        scheduleRegen(path.relative(partnersDir, filepath));
      };

      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);

      console.log(`[vault-solutions] watching ${partnersDir}`);
      console.log(`[vault-solutions] build script: ${buildScript}`);
    },
  };
}
