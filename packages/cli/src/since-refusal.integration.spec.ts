import { expect, test } from 'bun:test';
import { removeTempTree } from '@archon/paths/test-utils';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const commands = [
  ['metrics'],
  ['workflow', 'attention', '--all', '--notices'],
  ['workflow', 'attention', '--all', '--count-by', 'project'],
];

for (const command of commands) {
  for (const json of [false, true]) {
    test.each(['40x', '40x\nsecond line\rthird line'])(
      `${command.join(' ')} refuses --since %j (json: ${String(json)})`,
      async since => {
        const home = mkdtempSync(join(tmpdir(), 'archon-since-refusal-'));
        try {
          writeFileSync(join(home, 'config.yaml'), 'store: files\n');
          const result = spawnSync(
            process.execPath,
            [
              join(import.meta.dir, 'cli.ts'),
              ...command,
              '--since',
              since,
              ...(json ? ['--json'] : []),
            ],
            {
              cwd: home,
              env: {
                ...process.env,
                ARCHON_HOME: home,
                ARCHON_TELEMETRY_DISABLED: '1',
                ARCHON_WORKFLOW_CODEBASE_ID: '',
                DEBUG: '',
              },
              encoding: 'utf8',
            }
          );
          expect(result.status).toBe(1);
          const message =
            'since must be a duration such as 40m, 24h, 7d or 2w, or an ISO date or a time ' +
            'with an offset, such as 2026-10-01 or 2026-10-01T12:00:00Z; got ' +
            JSON.stringify(since);
          if (json && command[0] === 'workflow') {
            expect(result.stderr).toBe('');
            expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: message });
          } else {
            expect(result.stdout).toBe('');
            const prefix = command[0] === 'workflow' ? 'Failed to read the attention queue: ' : '';
            expect(result.stderr).toBe(`Error: ${prefix}${message}\n`);
          }
        } finally {
          await removeTempTree(home);
        }
      }
    );
  }
}
