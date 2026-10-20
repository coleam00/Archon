import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import { requestRunLiveOwnerStop } from '@archon/core/services/run-live-owner';

const posix = process.platform === 'win32' ? test.skip : test;
const trackTempRoot = trackTempRoots();
const exec = promisify(execFile);
const cli = join(import.meta.dir, 'fixtures/detached-node-cli.ts');
const worker = join(import.meta.dir, 'fixtures/detached-node-worker.ts');

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Detached CLI fixture did not reach expected state');
    await Bun.sleep(20);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}

async function launch(kind: 'bash' | 'script', mode: 'timeout' | 'live' | 'reaped') {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-node-cli-')));
  const home = join(dir, 'home');
  const project = join(dir, 'project');
  mkdirSync(home);
  mkdirSync(join(project, '.archon/workflows'), { recursive: true });
  writeFileSync(join(home, 'config.yaml'), 'store: files\n');
  const rootFile = join(dir, 'root');
  const role = mode === 'reaped' ? 'grandchild' : 'child';
  const command = [process.execPath, worker, dir, role];
  const script = `require('fs').writeFileSync(${JSON.stringify(rootFile)}, String(process.pid)); const c = Bun.spawn(${JSON.stringify(command)}, {stdio: ['ignore', 'inherit', 'inherit']}); ${mode === 'reaped' ? 'process.exit(0);' : 'await c.exited;'}`;
  const shell = `echo $$ > '${rootFile}'; ${command.map(arg => `'${arg}'`).join(' ')} & ${mode === 'reaped' ? 'exit 0' : 'wait'}`;
  const body =
    kind === 'bash'
      ? `bash: ${JSON.stringify(shell)}`
      : `runtime: bun\n    script: ${JSON.stringify(script)}`;
  writeFileSync(
    join(project, '.archon/workflows/test.yaml'),
    `name: test\ndescription: detached command ownership fixture\nnodes:\n  - id: wrapped\n    ${body}\n${mode === 'timeout' ? '    timeout: 1200\n' : ''}`
  );
  const env = {
    ...process.env,
    ARCHON_HOME: home,
    ARCHON_TELEMETRY_DISABLED: '1',
    DATABASE_URL: '',
    ARCHON_SPEC_SIGNAL_LOG: join(dir, 'signals'),
  };
  const invoke = async (...args: string[]) => {
    const result = await exec(process.execPath, [cli, ...args], { env, timeout: 15000 });
    return JSON.parse(result.stdout) as { ok: boolean; runId: string; cleanupWarnings?: string[] };
  };
  const receipt = await invoke(
    'workflow',
    'run',
    'test',
    '--folder',
    '--detach',
    '--json',
    '--cwd',
    project
  );
  expect(receipt.ok).toBe(true);
  const store = await createFileWorkflowStore({ root: join(home, 'store') });
  const runId = receipt.runId;
  const pid = (role: string) => Number(readFileSync(join(dir, role), 'utf8'));
  const cleanup = async () => {
    const row = await store.getWorkflowRun(runId);
    if (row?.status === 'running')
      await invoke('workflow', 'cancel', runId, '--json').catch(() => undefined);
    for (const role of ['root', 'child', 'grandchild']) {
      if (existsSync(join(dir, role))) {
        const value = pid(role);
        if (alive(value)) process.kill(value, 'SIGKILL');
      }
    }
  };
  return { dir, runId, store, invoke, pid, cleanup };
}

for (const kind of ['bash', 'script'] as const) {
  posix(
    `detached ${kind} timeout ends the wrapper, child and grandchild before ordinary timeout`,
    async () => {
      const run = await launch(kind, 'timeout');
      try {
        await until(async () => (await run.store.getWorkflowRun(run.runId))?.status === 'failed');
        for (const role of ['root', 'child', 'grandchild'])
          expect(alive(run.pid(role))).toBe(false);
        const events = await run.store.listWorkflowEvents(run.runId);
        expect(
          events.some(
            event => event.event_type === 'node_failed' && event.data?.failure_kind === 'timeout'
          )
        ).toBe(true);
        await Bun.sleep(2600);
        expect(existsSync(join(run.dir, 'marker'))).toBe(false);
      } finally {
        await run.cleanup();
      }
    },
    15000
  );
}

posix(
  'detached live-node cancellation confirms all descendants gone and isolates another run',
  async () => {
    const run = await launch('script', 'live');
    const other = await launch('bash', 'live');
    try {
      await until(
        () => existsSync(join(run.dir, 'grandchild')) && existsSync(join(other.dir, 'grandchild'))
      );
      const result = await run.invoke('workflow', 'cancel', run.runId, '--json');
      expect(result.ok).toBe(true);
      expect(result.cleanupWarnings).toBeUndefined();
      for (const role of ['root', 'child', 'grandchild']) expect(alive(run.pid(role))).toBe(false);
      expect((await run.store.getWorkflowRun(run.runId))?.status).toBe('cancelled');
      expect(alive(other.pid('grandchild'))).toBe(true);
      expect((await other.store.getWorkflowRun(other.runId))?.status).toBe('running');
      const events = await run.store.listWorkflowEvents(run.runId);
      expect(events.some(event => event.event_type === 'workflow_failed')).toBe(false);
    } finally {
      await run.cleanup();
      await other.cleanup();
    }
  },
  20000
);

posix(
  'reaped-node cancellation ends the run, reports survivors in result and stored event, and never signals its group',
  async () => {
    const run = await launch('bash', 'reaped');
    try {
      await until(() => existsSync(join(run.dir, 'grandchild')) && !alive(run.pid('root')));
      const root = run.pid('root');
      const survivor = run.pid('grandchild');
      const result = await run.invoke('workflow', 'cancel', run.runId, '--json');
      expect(result.ok).toBe(true);
      expect(alive(survivor)).toBe(true);
      expect((await run.store.getWorkflowRun(run.runId))?.status).toBe('cancelled');
      const warning = result.cleanupWarnings?.join('\n') ?? '';
      expect(warning).toContain(`PID ${String(survivor)}`);
      expect(warning).toContain(`PGID ${String(root)}`);
      expect(warning).toContain('bun');
      expect(warning).toContain('leader was reaped');
      const cancelled = (await run.store.listWorkflowEvents(run.runId)).find(
        event => event.event_type === 'workflow_cancelled'
      );
      expect(cancelled?.data?.cancel_reason).toBe('operator');
      expect(cancelled?.data?.reason).toBe(warning);
      const signals: { pid: number }[] = readFileSync(join(run.dir, 'signals'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(signals.filter(signal => signal.pid === -root)).toEqual([]);
    } finally {
      await run.cleanup();
    }
  },
  15000
);

posix(
  'a disconnected cancel controller releases command settlement instead of stranding the executor',
  async () => {
    const run = await launch('script', 'live');
    try {
      await until(() => existsSync(join(run.dir, 'grandchild')));
      const lease = await requestRunLiveOwnerStop(run.runId);
      try {
        const prepared = await lease.commit();
        expect(prepared?.groups).toHaveLength(1);
        expect((await run.store.getWorkflowRun(run.runId))?.status).toBe('running');
      } finally {
        lease.release();
      }
      await until(async () => (await run.store.getWorkflowRun(run.runId))?.status === 'failed');
      for (const role of ['root', 'child', 'grandchild']) expect(alive(run.pid(role))).toBe(false);
    } finally {
      await run.cleanup();
    }
  },
  15000
);
