import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';

let temporary: string;
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'archon-native-queue-'));
});
afterEach(async () => {
  await removeTempTree(temporary);
});
for (const scenario of [
  'green',
  'auto_green',
  'auto_failed_review',
  'auto_changed_input',
  'auto_missing_assessment',
]) {
  test(`native queue, durable gates and resume: ${scenario}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        join(import.meta.dir, 'sdlc-queue-native-harness.ts'),
        temporary,
        scenario,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          ARCHON_HOME: join(temporary, 'home'),
          DATABASE_URL: '',
          ARCHON_LOG_LEVEL: 'silent',
          ARCHON_TELEMETRY_DISABLED: 'true',
          PYTHONDONTWRITEBYTECODE: '1',
        },
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, error: code ? stdout + stderr : '' }).toEqual({ code: 0, error: '' });
  }, 120_000);
}
