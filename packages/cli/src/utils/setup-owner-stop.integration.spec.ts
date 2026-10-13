import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { requestDetachedRunStop } from '@archon/core/services/run-owner-stop';

const trackTempRoot = trackTempRoots();

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for setup fixture');
    await Bun.sleep(25);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

// POSIX groups and owner-only SIGKILL are the lifeline's contract.
describe.skipIf(process.platform === 'win32')('setup owner stop', () => {
  for (const background of [false, true]) {
    for (const stop of ['SIGINT', 'SIGKILL', 'detached stop'] as const) {
      test(`${stop} ends ${background ? 'background' : 'foreground'} setup descendants`, async () => {
        const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-setup-owner-')));
        const runId = crypto.randomUUID();
        const owner = spawn(
          process.execPath,
          [join(import.meta.dir, 'fixtures/setup-run-owner.ts'), runId, root, String(background)],
          {
            detached: true,
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {
              ...process.env,
              ARCHON_HOME: join(root, 'home'),
              ARCHON_TELEMETRY_DISABLED: '1',
              DATABASE_URL: '',
            },
          }
        );
        if (owner.pid === undefined) throw new Error('Missing fixture PID');
        let stderr = '';
        owner.stderr?.on('data', chunk => {
          stderr += String(chunk);
        });
        const exited = new Promise<void>(resolve => owner.once('exit', () => resolve()));
        try {
          await waitFor(() => {
            if (owner.exitCode !== null || owner.signalCode !== null) throw new Error(stderr);
            return existsSync(join(root, 'ready'));
          });
          const descendantPid = Number(readFileSync(join(root, 'descendant.pid'), 'utf8'));
          expect(processExists(descendantPid)).toBe(true);
          if (stop === 'detached stop') {
            const target = await requestDetachedRunStop(runId);
            try {
              await target.stop();
            } finally {
              target.release();
            }
          } else {
            process.kill(stop === 'SIGINT' ? -owner.pid : owner.pid, stop);
          }
          await exited;
          await waitFor(() => !processExists(descendantPid));
          writeFileSync(join(root, 'go'), '');
          expect(existsSync(join(root, 'leaked'))).toBe(false);
        } finally {
          owner.kill('SIGKILL');
          await exited;
          writeFileSync(join(root, 'go'), '');
          await Bun.sleep(100);
        }
      }, 20000);
    }
  }
});
