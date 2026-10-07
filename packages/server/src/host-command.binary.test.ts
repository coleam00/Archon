import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const home = mkdtempSync(join(tmpdir(), 'archon-server-binary-host-'));
process.env.ARCHON_HOME = home;
const command = JSON.stringify(['/installed/archon']);
process.env.ARCHON_CLI_COMMAND = command;
mock.module('@archon/paths/bundled-build', () => ({
  BUNDLED_IS_BINARY: true,
  BUNDLED_VERSION: '1.2.3',
  BUNDLED_GIT_COMMIT: 'test',
  BUNDLED_WEB_DIST_SHA256: '',
}));

afterAll(async () => {
  await removeTempTree(home);
});

test('compiled server preserves the launching CLI host command', async () => {
  await import('./index');
  expect(process.env.ARCHON_CLI_COMMAND).toBe(command);
});
