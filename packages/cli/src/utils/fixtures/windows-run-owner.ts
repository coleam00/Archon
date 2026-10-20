import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import { isRunOwnerAnswering, startRunLiveOwner } from '@archon/core/services/run-live-owner';
import { claimDetachedRunProcessOwner } from '../detached-run-control';

/*
 * A real detached run owner for the Windows stop tests. Every process it starts carries
 * `<dir>` on its command line, so the spec can find survivors by it.
 *
 * - `orphan`: start an intermediate that starts a detached grandchild and exits, so the
 *   grandchild's parent is gone before any stop begins.
 * - `spawner`: start a detached child every few milliseconds, so a stop races a spawn.
 * - `nested`: start a process, as a node would, that launches a real CLI workflow with
 *   `--detach` through the job broker. Its run id is saved in `<dir>/child-run-id`.
 * - `nested-approve`: pause that run at an approval, then continue with `approve --detach`.
 */

const [runId, dir, mode] = process.argv.slice(2);
const modes = ['orphan', 'spawner', 'nested', 'nested-approve', 'relay', 'relay-approve'];
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

async function runCli(args: string[]): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, '..', '..', 'cli.ts'),
      'workflow',
      ...args,
      '--detach',
      '--json',
      '--cwd',
      dir,
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        ARCHON_HOME: join(dir, 'home'),
        ARCHON_TELEMETRY_DISABLED: '1',
        DATABASE_URL: '',
      },
      stdout: 'pipe',
      stderr: 'inherit',
    }
  );
  const stdout = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`Nested CLI launch failed (${String(code)}): ${stdout}`);
  const ack: unknown = JSON.parse(stdout);
  if (
    typeof ack !== 'object' ||
    ack === null ||
    !('runId' in ack) ||
    typeof ack.runId !== 'string'
  ) {
    throw new Error('Nested CLI launch returned no run id');
  }
  return ack.runId;
}

if (mode === 'relay' || mode === 'relay-approve') {
  const childRunId = await runCli(['run', 'nested-child', '--folder']);
  if (mode === 'relay-approve') {
    const store = await createFileWorkflowStore({ root: join(dir, 'home', 'store') });
    while (
      (await store.getWorkflowRun(childRunId))?.status !== 'paused' ||
      (await isRunOwnerAnswering(childRunId))
    ) {
      await Bun.sleep(25);
    }
    const continuedRunId = await runCli(['approve', childRunId]);
    if (continuedRunId !== childRunId) throw new Error('Approval continued a different run');
  }
  writeFileSync(join(dir, 'child-run-id'), childRunId);
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
  } else if (mode === 'nested' || mode === 'nested-approve') {
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
${mode === 'nested-approve' ? '  - id: review\n    approval:\n      message: Continue?\n' : ''}  - id: hold
${mode === 'nested-approve' ? '    depends_on: [review]\n' : ''}    runtime: bun
    script: ${JSON.stringify(script)}
`
    );
    const relay = spawn(
      process.execPath,
      [import.meta.path, runId, dir, mode === 'nested-approve' ? 'relay-approve' : 'relay'],
      {
        stdio: 'ignore',
      }
    );
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
