/**
 * The Codex provider in a compiled binary spawns the binary the resolver's tiers find,
 * never the node_modules package a source install falls back to.
 *
 * Separate file because mock.module('@archon/paths') with BUNDLED_IS_BINARY=true
 * conflicts with provider.test.ts, which mocks it as a source install.
 */
import { describe, test, expect, mock } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMockLogger } from '../test/mocks/logger';

let archonHome = '';
mock.module('@archon/paths', () => ({
  createLogger: mock(() => createMockLogger()),
  BUNDLED_IS_BINARY: true,
  BUNDLED_VERSION: 'test',
  getArchonHome: () => archonHome,
}));

import { trackTempRoots } from '@archon/paths/test-utils';
import { createFakeAppServer } from '../test/codex-app-server-fake';
import { CodexProvider } from './provider';

const trackTempRoot = trackTempRoots();

describe('CodexProvider in a compiled binary', () => {
  test('spawns the vendored binary', async () => {
    archonHome = trackTempRoot(await mkdtemp(join(tmpdir(), 'codex-guard-')));
    const vendored = join(
      archonHome,
      'vendor',
      'codex',
      process.platform === 'win32' ? 'codex.exe' : 'codex'
    );
    await mkdir(join(archonHome, 'vendor', 'codex'), { recursive: true });
    await writeFile(vendored, '');

    const server = createFakeAppServer();
    for await (const _ of new CodexProvider(server).sendQuery('p', '/workspace')) {
      // drain
    }
    expect(server.processes.map(p => p.binary)).toEqual([vendored]);
  });
});
