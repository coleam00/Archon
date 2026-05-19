import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Vite plugin: regenerate `src/lib/contacts.generated.json` whenever a contact
 * file changes in the second-brain vault.
 *
 * Wires into Vite's existing chokidar watcher (no new deps). On startup it
 * adds the vault contacts dir to the watcher and on `change`/`add`/`unlink`
 * runs `scripts/build-contacts-json.py`. Vite's own HMR picks up the
 * regenerated JSON because it lives under `src/lib/` which Vite already
 * watches.
 *
 * Debounced 250ms — handles bursts (e.g. saving a file via Obsidian fires
 * multiple FS events). Fail-soft: build script errors are logged, never
 * crash the dev server.
 *
 * Path resolution uses Vite's `config.root` (set during `configResolved`)
 * rather than `__dirname` — `__dirname` is unreliable when Vite loads the
 * plugin via its own ESM/CJS interop layer.
 */
export function vaultContactsPlugin(): Plugin {
  let configRoot = ''; // packages/web/ (set by configResolved)
  let contactsDir = '';
  let buildScript = '';
  let resolved = false;

  let debounceTimer: NodeJS.Timeout | null = null;

  const regenerate = (reason: string): void => {
    const t0 = Date.now();
    const result = spawnSync('python3', [buildScript], {
      cwd: path.dirname(buildScript), // archon/scripts/
      encoding: 'utf-8',
      timeout: 10_000,
    });
    if (result.error) {
      console.warn(`[vault-contacts] build failed (${reason}):`, result.error.message);
      return;
    }
    if (result.status !== 0) {
      console.warn(
        `[vault-contacts] build exited ${result.status} (${reason}):`,
        (result.stderr || result.stdout || '').trim().slice(0, 500)
      );
      return;
    }
    const elapsed = Date.now() - t0;
    const summary = (result.stdout || '').trim().split('\n')[0] || 'rebuilt';
    console.log(`[vault-contacts] ${summary} (${elapsed}ms, ${reason})`);
  };

  const scheduleRegen = (reason: string): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => regenerate(reason), 250);
  };

  return {
    name: 'vault-contacts',
    apply: 'serve', // dev only — production builds run the script via package.json prebuild

    configResolved(config): void {
      configRoot = config.root; // e.g. /Users/.../archon/packages/web
      // From packages/web/, go up 2 to archon/, sibling-up to second-brain/.
      const archonRoot = path.resolve(configRoot, '..', '..');
      contactsDir = path.resolve(archonRoot, '..', 'second-brain', 'contacts');
      buildScript = path.resolve(archonRoot, 'scripts', 'build-contacts-json.py');
      resolved = true;

      // Sanity check up front — surface bad paths immediately.
      if (!existsSync(contactsDir)) {
        console.warn(`[vault-contacts] contacts dir not found: ${contactsDir}`);
      }
      if (!existsSync(buildScript)) {
        console.warn(`[vault-contacts] build script not found: ${buildScript}`);
      }
    },

    configureServer(server: ViteDevServer): void {
      if (!resolved) {
        console.warn('[vault-contacts] paths not resolved, skipping watcher setup');
        return;
      }

      // Tell Vite's existing chokidar watcher to also watch the vault contacts dir.
      // This is the same watcher Vite uses for src/, so no extra resources.
      server.watcher.add(contactsDir);

      // Initial build — covers the case where vault changed while dev server was
      // off. Cheap (12 files, <1s).
      regenerate('startup');

      const onChange = (filepath: string): void => {
        if (!filepath.startsWith(contactsDir)) return;
        if (!filepath.endsWith('.md')) return;
        // Skip MOC + sidecar files (mirror build script logic)
        const base = path.basename(filepath);
        if (base.startsWith('_') || base.endsWith('.sidecar.md')) return;
        scheduleRegen(path.relative(contactsDir, filepath));
      };

      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);

      console.log(`[vault-contacts] watching ${contactsDir}`);
      console.log(`[vault-contacts] build script: ${buildScript}`);
    },
  };
}
