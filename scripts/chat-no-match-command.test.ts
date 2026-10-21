import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

test('the telemetry no-match command reaches the CLI dispatcher', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-no-match-command-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--no-env-file',
        join(import.meta.dir, '../packages/cli/src/cli.ts'),
        'telemetry',
        'no-match',
      ],
      {
        cwd: root,
        env: { ...process.env, ARCHON_HOME: root, ARCHON_TELEMETRY_DISABLED: '1' },
        encoding: 'utf8',
      }
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('No workflow match recorded.');
  } finally {
    await removeTempTree(root);
  }
});
