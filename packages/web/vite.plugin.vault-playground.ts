import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Plugin } from 'vite';

/**
 * Watch the Playground source data (Apollo CSV, dial-tracker history,
 * dial-queue JSONs) and re-run the build script on change. Output goes
 * to packages/web/src/lib/playground.generated.json which the route
 * imports statically (Vite HMR pushes the update to the browser).
 *
 * Pattern: vault-driven-dashboard skill, three-state path resolution
 * via configResolved(config).root so __dirname quirks don't bite.
 */
export function vaultPlaygroundPlugin(): Plugin {
  let configRoot = '';
  let buildScript = '';
  let csvPath = '';
  let historyPath = '';
  let debounceTimer: NodeJS.Timeout | null = null;

  const runBuild = (trigger: string): void => {
    const t0 = Date.now();
    const result = spawnSync('python3', [buildScript], { encoding: 'utf-8' });
    const ms = Date.now() - t0;
    if (result.status === 0) {
      // eslint-disable-next-line no-console
      console.log(`[vault-playground] rebuilt (${ms}ms, ${trigger})`);
    } else {
      // eslint-disable-next-line no-console
      console.error(`[vault-playground] build failed (${trigger}):`, result.stderr);
    }
  };

  return {
    name: 'vault-playground',
    apply: 'serve',
    configResolved(config) {
      configRoot = config.root; // packages/web/
      const archonRoot = path.resolve(configRoot, '..', '..');
      const jidRoot = path.resolve(archonRoot, '..');
      buildScript = path.resolve(archonRoot, 'scripts', 'build-playground-json.py');
      csvPath = path.resolve(
        jidRoot,
        'second-brain',
        'intelligence',
        'briefs',
        '2026-05-13-apollo-dial-list-all.csv'
      );
      historyPath = path.resolve(process.env.HOME ?? '', '.hermes/state/dial_tracker_history.json');

      if (!existsSync(buildScript)) {
        // eslint-disable-next-line no-console
        console.warn(`[vault-playground] build script missing: ${buildScript}`);
      }
    },
    configureServer(server) {
      // Initial build on startup
      runBuild('startup');

      // Watch CSV + history file
      if (existsSync(csvPath)) server.watcher.add(csvPath);
      if (existsSync(historyPath)) server.watcher.add(historyPath);

      const onChange = (file: string): void => {
        if (file !== csvPath && file !== historyPath) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          runBuild(path.basename(file));
        }, 250);
      };

      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);
    },
  };
}
