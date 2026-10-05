/**
 * Adapter tests must not write to the default ARCHON_HOME (#2308). Missing
 * @archon/core mocks can create a database, config or credential helper silently;
 * mock.module() merges exports, leaving omitted implementations real.
 *
 * The preload redirects ARCHON_HOME to an empty guard-owned temp directory.
 * afterEach reports entries even when the adapter swallowed its I/O error.
 * Tests needing real filesystem state must set ARCHON_HOME to their own mkdtemp
 * directory and restore it after cleaning up; only the guard's directory is checked.
 *
 * Bun loads bunfig.toml from cwd: use bun run test or bun test inside
 * packages/adapters. A repo-root bun test packages/adapters/... bypasses this guard.
 * Writes removed before afterEach, or made after the final afterEach, are not detected.
 */
import { afterAll, afterEach } from 'bun:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const guardedHome = mkdtempSync(join(tmpdir(), 'archon-adapters-home-guard-'));
process.env.ARCHON_HOME = guardedHome;
// getArchonHome() gives Docker detection precedence over ARCHON_HOME. Test homes
// must remain authoritative even when the runner inherits container settings.
process.env.ARCHON_DOCKER = '';
process.env.WORKSPACE_PATH = '';

afterEach(() => {
  const entries = readdirSync(guardedHome, { recursive: true, encoding: 'utf8' });
  if (entries.length === 0) return;
  throw new Error(
    'Adapter test wrote under guard-owned ARCHON_HOME:\n' +
      entries.map(entry => `  - ${join(guardedHome, entry)}`).join('\n') +
      '\nAn @archon/core export may be unmocked; mock.module() merges, so check every ' +
      'factory in this file. Tests needing filesystem state must own their own mkdtemp directory.'
  );
});

afterAll(async () => {
  await removeTempTree(guardedHome);
});
