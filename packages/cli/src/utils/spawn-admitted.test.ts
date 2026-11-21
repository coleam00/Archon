// @archon-test-isolated
// @archon-test-windows
import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { ResourceStartRequestInspection } from '@archon/workflows/resource-start-store';

// The executor is a script run by this Bun, which writes its own pid where it starts.
let program: [string, ...string[]] = [process.execPath];
mock.module('./cli-program-arguments', () => ({ cliProgramArguments: () => program }));
const { spawnAdmitted } = await import('./spawn-admitted');
const { RUN_JOB_ESCAPE_ENV } = await import('./run-job-escape');
const { HandOffUncertainError } = await import('@archon/core/workflows/start-executor');

const track = trackTempRoots();
const archonHome = process.env.ARCHON_HOME;
afterAll(() => {
  if (archonHome === undefined) Reflect.deleteProperty(process.env, 'ARCHON_HOME');
  else process.env.ARCHON_HOME = archonHome;
});

function admittedIn(cwd: string) {
  const request: ResourceStartRequestInspection = {
    id: 'request',
    resource: 'build',
    hostId: 'host',
    overlap: 'queue',
    status: 'admitted',
    runStatus: 'pending',
    blocker: null,
    blockerRunStatus: null,
    launch: {
      version: 2,
      run: {
        id: 'request',
        workflow_name: 'deliver',
        codebase_id: 'c',
        user_message: '',
        metadata: {},
      },
      execution: { cwd, conversationId: 'conversation', isolation: { kind: 'in-place' } },
    },
  };
  return { deps: { store: { getResourceStartRequest: async () => request } } };
}

test('the hand-off names the process it started', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'spawn-admitted-')));
  process.env.ARCHON_HOME = root;
  const script = join(root, 'executor.ts');
  await writeFile(script, "await Bun.write('executor.pid', String(process.pid));\n");
  program = [process.execPath, script];

  const executor = await spawnAdmitted(admittedIn(root), 'request', 'host');

  let written = '';
  for (let attempt = 0; attempt < 200 && written === ''; attempt++) {
    written = await readFile(join(root, 'executor.pid'), 'utf8').catch(() => '');
    if (written === '') await Bun.sleep(25);
  }
  expect(executor).toEqual({ pid: Number(written) });
});

test('a hand-off that cannot start its process rejects', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'spawn-admitted-')));
  process.env.ARCHON_HOME = root;
  program = [join(root, 'missing-executable')];

  await expect(spawnAdmitted(admittedIn(root), 'request', 'host')).rejects.toThrow();
});

test('a hand-off whose broker relay fails is uncertain, not a failure', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'spawn-admitted-')));
  process.env.ARCHON_HOME = root;
  // Inside a Windows run the executor starts through the run's broker; this one is gone.
  process.env[RUN_JOB_ESCAPE_ENV] = join(root, 'no-broker.sock');
  try {
    await expect(spawnAdmitted(admittedIn(root), 'request', 'host')).rejects.toBeInstanceOf(
      HandOffUncertainError
    );
  } finally {
    Reflect.deleteProperty(process.env, RUN_JOB_ESCAPE_ENV);
  }
});
