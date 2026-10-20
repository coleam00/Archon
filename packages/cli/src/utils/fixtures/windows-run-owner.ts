import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startRunLiveOwner } from '@archon/core/services/run-live-owner';
import { claimDetachedRunProcessOwner } from '../detached-run-control';
import { relayOutsideRunJob, RUN_JOB_ESCAPE_ENV } from '../run-job-escape';

/*
 * A real detached run owner for the Windows stop tests. Every process it starts carries
 * `<dir>` on its command line, so the spec can find survivors by it.
 *
 * - `orphan`: start an intermediate that starts a detached grandchild and exits, so the
 *   grandchild's parent is gone before any stop begins.
 * - `spawner`: start a detached child every few milliseconds, so a stop races a spawn.
 * - `nested`: start a process, as a node would, that launches a real CLI workflow with
 *   `--detach` through the job broker. Its run id is saved in `<dir>/child-run-id`.
 */

const [runId, dir, mode] = process.argv.slice(2);
const modes = ['orphan', 'spawner', 'nested', 'relay'];
if (!runId || !dir || !mode || !modes.includes(mode)) {
  throw new Error(`Usage: windows-run-owner.ts <run-id> <dir> <${modes.join('|')}>`);
}

const idle = 'setInterval(() => undefined, 1000);';

function writeReady(): void {
  // Written aside and renamed into place: the spec reads the file as soon as it exists.
  const readyPath = join(dir, 'ready');
  writeFileSync(`${readyPath}.tmp`, String(process.pid));
  renameSync(`${readyPath}.tmp`, readyPath);
}

if (mode === 'relay') {
  const pipe = process.env[RUN_JOB_ESCAPE_ENV];
  if (pipe === undefined) throw new Error(`${RUN_JOB_ESCAPE_ENV} is not set`);
  const stdout: Buffer[] = [];
  const code = await relayOutsideRunJob(
    pipe,
    {
      argv: [
        process.execPath,
        resolve(import.meta.dir, '..', '..', 'cli.ts'),
        'workflow',
        'run',
        'nested-child',
        '--folder',
        '--detach',
        '--json',
        '--cwd',
        dir,
      ],
      cwd: dir,
      env: { ...process.env, ARCHON_HOME: join(dir, 'home'), ARCHON_TELEMETRY_DISABLED: '1' },
    },
    {
      stdout: async data => {
        stdout.push(Buffer.from(data));
      },
      stderr: async data => {
        process.stderr.write(data);
      },
    }
  );
  if (code !== 0)
    throw new Error(
      `Nested CLI launch failed (${String(code)}): ${Buffer.concat(stdout).toString()}`
    );
  const ack: unknown = JSON.parse(Buffer.concat(stdout).toString());
  if (
    typeof ack !== 'object' ||
    ack === null ||
    !('runId' in ack) ||
    typeof ack.runId !== 'string'
  ) {
    throw new Error('Nested CLI launch returned no run id');
  }
  writeFileSync(join(dir, 'child-run-id'), ack.runId);
  process.exit(0);
} else {
  await claimDetachedRunProcessOwner();
  await startRunLiveOwner(runId, { detachedProcessPid: process.pid });

  if (mode === 'orphan') {
    const intermediate = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          'const dir = process.argv[1];',
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(idle)}, dir], { detached: true, stdio: 'ignore' });`,
          "fs.writeFileSync(path.join(dir, 'grandchild'), String(child.pid));",
          'process.exit(0);',
        ].join('\n'),
        dir,
      ],
      { stdio: 'ignore' }
    );
    intermediate.on('error', error => {
      throw error;
    });
    intermediate.once('exit', writeReady);
  } else if (mode === 'spawner') {
    const kidsDir = join(dir, 'kids');
    const loop = (): void => {
      const child = spawn(process.execPath, ['-e', idle, dir], { detached: true, stdio: 'ignore' });
      writeFileSync(join(kidsDir, String(child.pid)), '');
      setTimeout(loop, 10);
    };
    mkdirSync(kidsDir);
    loop();
    writeReady();
  } else if (mode === 'nested') {
    const workflows = join(dir, '.archon', 'workflows');
    mkdirSync(workflows, { recursive: true });
    mkdirSync(join(dir, 'home'));
    writeFileSync(join(dir, 'home', 'config.yaml'), 'store: files\n');
    const readyPath = join(dir, 'child-ready');
    const script = `import { writeFileSync, renameSync } from 'node:fs'; writeFileSync(${JSON.stringify(`${readyPath}.tmp`)}, String(process.pid)); renameSync(${JSON.stringify(`${readyPath}.tmp`)}, ${JSON.stringify(readyPath)}); setInterval(() => {}, 1000);`;
    writeFileSync(
      join(workflows, 'nested-child.yaml'),
      `name: nested-child
description: Nested detached owner fixture
worktree:
  enabled: false
nodes:
  - id: hold
    runtime: bun
    script: ${JSON.stringify(script)}
`
    );
    const relay = spawn(process.execPath, [import.meta.path, runId, dir, 'relay'], {
      stdio: 'ignore',
    });
    relay.on('error', error => {
      throw error;
    });
    relay.once('exit', code => {
      if (code !== 0) throw new Error(`The nested launch exited ${String(code)}`);
      writeReady();
    });
  }

  setInterval(() => undefined, 1_000);
}
