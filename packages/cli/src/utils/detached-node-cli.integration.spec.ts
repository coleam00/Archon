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

type FixtureMode =
  | 'completed'
  | 'completed-resumed'
  | 'escaped-redirected'
  | 'timeout'
  | 'live'
  | 'reaped'
  | 'escaped'
  | 'escaped-live'
  | 'overlap-timeout'
  | 'overlap-buffer';

function commandBody(kind: 'bash' | 'script', mode: FixtureMode, dir: string): string {
  const rootFile = join(dir, 'root');
  const completed = mode === 'completed' || mode === 'completed-resumed';
  const exitsAfterSpawn = completed || ['reaped', 'escaped'].includes(mode);
  const overlap = ['overlap-timeout', 'overlap-buffer'].includes(mode);
  const role =
    exitsAfterSpawn || mode === 'escaped-live' || mode === 'escaped-redirected'
      ? 'grandchild'
      : 'child';
  const command = [process.execPath, worker, dir, overlap ? 'stubborn' : role];
  let afterSpawn = 'await c.exited;';
  if (completed) afterSpawn = 'c.unref();';
  else if (exitsAfterSpawn) afterSpawn = 'process.exit(0);';
  if (mode === 'overlap-buffer')
    afterSpawn = `while (!require('fs').existsSync(${JSON.stringify(join(dir, 'stubborn'))})) await Bun.sleep(10); process.stdout.write('x'.repeat(2 * 1024 * 1024)); await c.exited;`;
  const script = `require('fs').writeFileSync(${JSON.stringify(rootFile)}, String(process.pid)); const c = Bun.spawn(${JSON.stringify(command)}, {detached: ${['escaped', 'escaped-live', 'escaped-redirected'].includes(mode)}, stdio: ${JSON.stringify(completed || mode === 'escaped-redirected' ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'inherit', 'inherit'])}}); ${afterSpawn}`;
  const shell = `echo $$ > '${rootFile}'; ${command.map(arg => `'${arg}'`).join(' ')} ${completed ? '</dev/null >/dev/null 2>&1' : ''} & ${exitsAfterSpawn ? 'exit 0' : 'wait'}`;
  return kind === 'bash'
    ? `bash: ${JSON.stringify(shell)}`
    : `runtime: bun\n    script: ${JSON.stringify(script)}`;
}

function workflowYaml(kind: 'bash' | 'script', mode: FixtureMode, dir: string): string {
  const completed = ['completed', 'completed-resumed'].includes(mode);
  const active = `echo $$ > '${join(dir, 'active')}'; exec /bin/sleep 30`;
  return `name: test\ndescription: detached command ownership fixture\nnodes:\n  - id: wrapped\n    ${commandBody(kind, mode, dir)}\n${mode === 'timeout' || mode === 'overlap-timeout' ? '    timeout: 1200\n' : ''}${mode === 'completed-resumed' ? '  - id: review\n    depends_on: [wrapped]\n    approval:\n      message: Continue?\n' : ''}${completed ? `  - id: active\n    depends_on: [${mode === 'completed-resumed' ? 'review' : 'wrapped'}]\n    bash: ${JSON.stringify(active)}\n` : ''}`;
}

async function launch(kind: 'bash' | 'script', mode: FixtureMode) {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-node-cli-')));
  const home = join(dir, 'home');
  const project = join(dir, 'project');
  mkdirSync(home);
  mkdirSync(join(project, '.archon/workflows'), { recursive: true });
  writeFileSync(join(home, 'config.yaml'), 'store: files\n');
  writeFileSync(join(project, '.archon/workflows/test.yaml'), workflowYaml(kind, mode, dir));
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
    for (const role of ['root', 'child', 'grandchild', 'stubborn', 'active']) {
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
        await Bun.sleep(2600);
        expect(existsSync(join(run.dir, 'marker'))).toBe(false);
        for (const role of ['root', 'child', 'grandchild'])
          expect(alive(run.pid(role))).toBe(false);
        const events = await run.store.listWorkflowEvents(run.runId);
        expect(
          events.some(
            event => event.event_type === 'node_failed' && event.data?.failure_kind === 'timeout'
          )
        ).toBe(true);
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
      expect(result.cleanupWarnings?.join(' ')).toContain(
        'may have left untracked background work'
      );
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

posix.each(['reaped', 'escaped', 'escaped-live'] as const)(
  '%s-node cancellation ends the run, reports held output in result and stored event, and signals only safe groups',
  async mode => {
    const run = await launch('script', mode);
    try {
      await until(
        () =>
          existsSync(join(run.dir, 'grandchild')) &&
          (mode === 'escaped-live' || !alive(run.pid('root')))
      );
      const root = run.pid('root');
      const survivor = run.pid('grandchild');
      const result = await run.invoke('workflow', 'cancel', run.runId, '--json');
      expect(result.ok).toBe(true);
      expect(alive(survivor)).toBe(true);
      expect((await run.store.getWorkflowRun(run.runId))?.status).toBe('cancelled');
      const warning = result.cleanupWarnings?.join('\n') ?? '';
      expect(warning).toContain("outside the run's process group still holds the node's output");
      expect(warning).toContain('it was not signalled');
      expect(warning).toContain("lsof on the run's checkout");
      expect(warning).not.toContain(`PID ${String(survivor)}`);
      const cancelled = (await run.store.listWorkflowEvents(run.runId)).find(
        event => event.event_type === 'workflow_cancelled'
      );
      expect(cancelled?.data?.cancel_reason).toBe('operator');
      expect(cancelled?.data?.reason).toBe(warning);
      const signals: { pid: number }[] = readFileSync(join(run.dir, 'signals'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(signals.filter(signal => signal.pid === -root)).toHaveLength(
        mode === 'escaped-live' ? 1 : 0
      );
      expect(signals.filter(signal => signal.pid === -survivor)).toEqual([]);
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

posix.each(['overlap-timeout', 'overlap-buffer'] as const)(
  'cancel during %s confirmation ends the run without signalling its reaped group',
  async mode => {
    const run = await launch('script', mode);
    try {
      await until(() => existsSync(join(run.dir, 'stubborn')) && !alive(run.pid('root')));
      expect((await run.store.getWorkflowRun(run.runId))?.status).toBe('running');
      expect(alive(run.pid('stubborn'))).toBe(true);
      const result = await run.invoke('workflow', 'cancel', run.runId, '--json');
      expect(result.ok).toBe(true);
      expect((await run.store.getWorkflowRun(run.runId))?.status).toBe('cancelled');
      expect(alive(run.pid('stubborn'))).toBe(true);
      const warning = result.cleanupWarnings?.join('\n');
      expect(warning).toContain('it was not signalled');
      expect(
        (await run.store.listWorkflowEvents(run.runId)).find(
          event => event.event_type === 'workflow_cancelled'
        )?.data?.reason
      ).toBe(warning);
      const signals: { pid: number; signal: string }[] = readFileSync(
        join(run.dir, 'signals'),
        'utf8'
      )
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(signals.filter(signal => signal.pid === -run.pid('root'))).toEqual([
        { pid: -run.pid('root'), signal: 'SIGTERM' },
      ]);
    } finally {
      await run.cleanup();
    }
  },
  15000
);

for (const kind of ['bash', 'script'] as const) {
  for (const mode of ['completed', 'completed-resumed'] as const) {
    posix(
      `cancelling ${mode} after a completed ${kind} node reports possible leftovers without signalling them`,
      async () => {
        const run = await launch(kind, mode);
        let other: Awaited<ReturnType<typeof launch>> | undefined;
        try {
          if (mode === 'completed-resumed') {
            await until(
              async () => (await run.store.getWorkflowRun(run.runId))?.status === 'paused'
            );
            await run.invoke('workflow', 'approve', run.runId, '--detach', '--json');
          }
          other = await launch('script', 'live');
          const unrelated = other;
          await until(
            async () =>
              existsSync(join(run.dir, 'active')) &&
              existsSync(join(run.dir, 'grandchild')) &&
              existsSync(join(unrelated.dir, 'grandchild')) &&
              (await run.store.listWorkflowEvents(run.runId)).some(
                event => event.event_type === 'node_completed' && event.step_name === 'wrapped'
              )
          );
          const root = run.pid('root');
          const survivor = run.pid('grandchild');
          expect(alive(root)).toBe(false);
          const result = await run.invoke('workflow', 'cancel', run.runId, '--json');
          expect(result.ok).toBe(true);
          const warning = result.cleanupWarnings?.join('\n') ?? '';
          expect(warning).toContain('may have left untracked background work');
          expect(warning).toContain('No survivor or cleanup is confirmed');
          expect(warning).toContain("Inspect the run's checkout processes");
          expect(warning).toContain('lsof');
          expect(warning).toContain('verify ownership, and stop leftovers');
          for (const pid of [root, survivor]) expect(warning).not.toContain(String(pid));
          expect(alive(survivor)).toBe(true);
          expect(alive(run.pid('active'))).toBe(false);
          expect((await run.store.getWorkflowRun(run.runId))?.status).toBe('cancelled');
          const events = await run.store.listWorkflowEvents(run.runId);
          const cancelled = events.find(event => event.event_type === 'workflow_cancelled');
          expect(cancelled?.data?.cancel_reason).toBe('operator');
          expect(cancelled?.data?.warnings).toEqual(result.cleanupWarnings);
          expect(cancelled?.data?.reason).toBe(warning);
          expect(events.some(event => event.event_type === 'workflow_failed')).toBe(false);
          expect((await other.store.getWorkflowRun(other.runId))?.status).toBe('running');
          expect(alive(other.pid('grandchild'))).toBe(true);
          const signals: { pid: number; signal: string | number }[] = readFileSync(
            join(run.dir, 'signals'),
            'utf8'
          )
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));
          const forbidden = [root, survivor, ...['root', 'child', 'grandchild'].map(other.pid)];
          expect(
            signals.filter(
              signal => signal.signal !== 0 && forbidden.includes(Math.abs(signal.pid))
            )
          ).toEqual([]);
        } finally {
          await run.cleanup();
          await other?.cleanup();
        }
      },
      20000
    );
  }
}

posix(
  'a live command with redirected escaped work reports uncertainty in result and event',
  async () => {
    const run = await launch('script', 'escaped-redirected');
    try {
      await until(() => existsSync(join(run.dir, 'grandchild')));
      const survivor = run.pid('grandchild');
      const result = await run.invoke('workflow', 'cancel', run.runId, '--json');
      expect(result.ok).toBe(true);
      expect(alive(survivor)).toBe(true);
      expect(result.cleanupWarnings?.join(' ')).toContain(
        'may have left untracked background work'
      );
      const event = (await run.store.listWorkflowEvents(run.runId)).find(
        e => e.event_type === 'workflow_cancelled'
      );
      expect(event?.data?.warnings).toEqual(result.cleanupWarnings);
      const signals: { pid: number }[] = readFileSync(join(run.dir, 'signals'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(signals.filter(signal => Math.abs(signal.pid) === survivor)).toEqual([]);
    } finally {
      await run.cleanup();
    }
  },
  15000
);
