// @archon-test-windows
import { afterEach, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { SCHEDULE_LAUNCH_FLAG } from './schedule-launch-flag';

const CLI_ENTRY = join(import.meta.dir, '..', 'cli.ts');
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await removeTempTree(root);
});

// The task's own second hop, as Task Scheduler runs it: the CLI with the launch flag starts
// the wrapper through the native launcher, waits for it, and exits with its exit code.
it.skipIf(process.platform !== 'win32')(
  'a schedule launch runs the wrapper to its end and exits with its exit code',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'archon-schedule-launch-'));
    tempRoots.push(directory);
    const wrapper = join(directory, 'com.archon.trigger.launch.cmd');
    const ran = join(directory, 'ran.txt');
    await writeFile(wrapper, `@echo off\r\necho ran> "${ran}"\r\nexit /b 3\r\n`);

    const result = spawnSync(process.execPath, [CLI_ENTRY, SCHEDULE_LAUNCH_FLAG, wrapper], {
      cwd: directory,
      env: { ...process.env, ARCHON_HOME: directory, ARCHON_TELEMETRY_DISABLED: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(result.status).toBe(3);
    expect((await readFile(ran, 'utf8')).trim()).toBe('ran');
  }
);
