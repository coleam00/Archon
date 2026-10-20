import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import { isRunOwnerAnswering } from '@archon/core/services/run-live-owner';
import { requestDetachedRunStop } from '@archon/core/services/run-owner-stop';
import {
  acceptRelayConnection,
  isDetachedLaunch,
  relayOutsideRunJob,
  RUN_JOB_ESCAPE_ENV,
  serveRunJobEscape,
  waitForRunJobEscapeBroker,
} from './run-job-escape';

const trackTempRoot = trackTempRoots();

function stubProgram(): [string, string] {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-escape-cli-')));
  const path = join(dir, 'cli.ts');
  writeFileSync(
    path,
    `console.log(JSON.stringify({ marker: process.env.${RUN_JOB_ESCAPE_ENV} ?? null, cwd: process.cwd(), value: process.env.ARCHON_RELAY_TEST })); console.error('relayed'); process.exit(3);`
  );
  return [process.execPath, path];
}

async function bootBrokerStub(body: string) {
  const broker = spawn(
    process.execPath,
    ['-e', `console.log('booted'); process.stdin.once('data', () => { ${body} });`],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  await new Promise<void>((resolve, reject) => {
    broker.stdout.once('data', () => resolve());
    broker.once('error', reject);
  });
  return broker;
}

function brokerPipe(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\archon-escape-test-${crypto.randomUUID()}`
    : join(trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-escape-'))), 'broker.sock');
}

describe('run job escape', () => {
  // The broker's Windows-only part is where it runs, which the Windows integration spec
  // covers. The relay itself is plain IPC, so it runs on every platform.
  it('relays the output and exit status of a command that runs without the escape marker', async () => {
    const pipe = brokerPipe();
    const program = stubProgram();
    const server = await serveRunJobEscape(pipe, program);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    try {
      const exit = await relayOutsideRunJob(
        pipe,
        {
          argv: [...program, 'workflow', 'run', 'build', '--detach'],
          cwd: process.cwd(),
          env: { ...process.env, [RUN_JOB_ESCAPE_ENV]: pipe, ARCHON_RELAY_TEST: 'preserved' },
        },
        {
          stdout: async data => {
            stdout.push(Buffer.from(data));
          },
          stderr: async data => {
            stderr.push(Buffer.from(data));
          },
        }
      );
      expect(exit).toBe(3);
      // A relayed `--detach` that still carried the marker would relay itself forever.
      expect(JSON.parse(Buffer.concat(stdout).toString())).toEqual({
        marker: null,
        cwd: process.cwd(),
        value: 'preserved',
      });
      expect(Buffer.concat(stderr).toString()).toBe('relayed\n');
    } finally {
      await server.close();
    }
  });

  it('keeps serving after one connection fails', async () => {
    const pipe = brokerPipe();
    const program = stubProgram();
    let failFirst = true;
    // A launcher killed mid-invocation surfaces on the broker as an error on its connection.
    const server = createServer(socket => {
      acceptRelayConnection(socket, program);
      if (failFirst) {
        failFirst = false;
        socket.emit('error', new Error('write EPIPE'));
      }
    });
    await new Promise<void>(resolveListen => server.listen(pipe, resolveListen));
    try {
      const relay = (): Promise<number> =>
        relayOutsideRunJob(
          pipe,
          {
            argv: [...program, 'workflow', 'run', 'build', '--detach'],
            cwd: process.cwd(),
            env: {},
          },
          { stdout: async () => {}, stderr: async () => {} }
        );
      await expect(relay()).rejects.toThrow();
      expect(await relay()).toBe(3);
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });

  it('rejects commands outside the trusted CLI detached-run prefix at the broker', async () => {
    const program = stubProgram();
    const pipe = brokerPipe();
    const server = await serveRunJobEscape(pipe, program);
    const refused = [
      [process.execPath, '-e', 'process.exit(0)'],
      ['another-executable', ...program.slice(1), 'workflow', 'run', 'build', '--detach'],
      [process.execPath, 'another-cli.ts', 'workflow', 'run', 'build', '--detach'],
      [
        process.execPath,
        '--eval',
        'process.exit(0)',
        ...program.slice(1),
        'workflow',
        'run',
        'build',
        '--detach',
      ],
      [...program, 'trigger', 'fire', '--detach'],
      [...program, 'workflow', 'run', 'build'],
      [...program, 'workflow', 'run', 'build', '--', '--detach'],
      [...program, 'workflow', 'run', 'build', 'ship --detach later'],
    ];
    try {
      for (const argv of refused) {
        const [command, ...args] = argv;
        if (command === undefined) throw new Error('Empty test invocation');
        await expect(
          relayOutsideRunJob(pipe, {
            argv: [command, ...args],
            cwd: process.cwd(),
            env: {},
          })
        ).rejects.toThrow('Only this CLI');
      }
    } finally {
      await server.close();
    }
  });

  it('uses the real CLI prefix by default', async () => {
    const pipe = brokerPipe();
    const server = await serveRunJobEscape(pipe);
    const program = join(import.meta.dir, '..', 'cli.ts');
    try {
      expect(
        await relayOutsideRunJob(
          pipe,
          {
            argv: [process.execPath, program, 'workflow', 'run', '--detach', '--help'],
            cwd: process.cwd(),
            env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
          },
          { stdout: async () => {}, stderr: async () => {} }
        )
      ).toBe(0);
      await expect(
        relayOutsideRunJob(pipe, {
          argv: [...stubProgram(), 'workflow', 'run', 'build', '--detach'],
          cwd: process.cwd(),
          env: {},
        })
      ).rejects.toThrow('Only this CLI');
    } finally {
      await server.close();
    }
  });

  for (const channel of ['BUN_OPTIONS', 'bunfig.toml']) {
    it(`blocks ${channel} preloads with the real CLI prefix`, async () => {
      const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-preload-')));
      const preload = join(dir, 'preload.ts');
      writeFileSync(preload, 'process.exit(23);');
      const env = { ...process.env, ARCHON_TELEMETRY_DISABLED: '1', BUN_OPTIONS: '' };
      if (channel === 'BUN_OPTIONS') env.BUN_OPTIONS = `--preload ${preload}`;
      else writeFileSync(join(dir, 'bunfig.toml'), 'preload = ["./preload.ts"]');
      const pipe = brokerPipe();
      const server = await serveRunJobEscape(pipe);
      try {
        expect(
          await relayOutsideRunJob(
            pipe,
            {
              argv: [
                process.execPath,
                join(import.meta.dir, '..', 'cli.ts'),
                'workflow',
                'run',
                '--detach',
                '--help',
              ],
              cwd: dir,
              env,
            },
            { stdout: async () => {}, stderr: async () => {} }
          )
        ).toBe(0);
      } finally {
        await server.close();
      }
    });
  }

  it('keeps project preloads out of the detached executor until it owns the run', async () => {
    const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-executor-preload-')));
    const home = join(dir, 'home');
    const marker = join(dir, 'unowned-preload');
    const ready = join(dir, 'node-ready');
    mkdirSync(home);
    mkdirSync(join(dir, '.archon', 'workflows'), { recursive: true });
    writeFileSync(join(home, 'config.yaml'), 'store: files\n');
    writeFileSync(join(dir, 'bunfig.toml'), 'preload = ["./preload.ts"]');
    writeFileSync(
      join(dir, 'preload.ts'),
      `if (process.env.ARCHON_DETACHED_RUN_OWNER === '1') { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unowned'); process.exit(23); }`
    );
    writeFileSync(
      join(dir, '.archon', 'workflows', 'hold.yaml'),
      `name: hold
description: Detached executor preload fixture
worktree:
  enabled: false
nodes:
  - id: hold
    runtime: bun
    script: ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`)}
`
    );
    const store = await createFileWorkflowStore({ root: join(home, 'store') });
    const pipe = brokerPipe();
    const server = await serveRunJobEscape(pipe);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let runId: string | undefined;
    try {
      const exit = await relayOutsideRunJob(
        pipe,
        {
          argv: [
            process.execPath,
            join(import.meta.dir, '..', 'cli.ts'),
            'workflow',
            'run',
            'hold',
            '--folder',
            '--detach',
            '--json',
          ],
          cwd: dir,
          env: {
            ...process.env,
            ARCHON_HOME: home,
            ARCHON_TELEMETRY_DISABLED: '1',
            DATABASE_URL: '',
            BUN_OPTIONS: '',
          },
        },
        {
          stdout: async data => {
            stdout.push(Buffer.from(data));
          },
          stderr: async data => {
            stderr.push(Buffer.from(data));
          },
        }
      );
      expect(existsSync(marker)).toBe(false);
      expect(exit, Buffer.concat(stdout).toString() + Buffer.concat(stderr).toString()).toBe(0);
      const ack: { runId: string } = JSON.parse(Buffer.concat(stdout).toString());
      runId = ack.runId;
      const deadline = Date.now() + 15_000;
      while (!existsSync(ready) || !(await isRunOwnerAnswering(runId))) {
        if (Date.now() >= deadline) throw new Error('Detached executor did not claim its owner');
        await Bun.sleep(25);
      }
      expect((await store.getWorkflowRun(runId))?.status).toBe('running');
      expect(existsSync(marker)).toBe(false);
      await (await requestDetachedRunStop(runId)).stop();
      runId = undefined;
    } finally {
      if (runId && (await isRunOwnerAnswering(runId))) {
        await (await requestDetachedRunStop(runId)).stop();
      }
      await server.close();
    }
  }, 30_000);

  it('launches a detached source CLI with a relative Bun config and a different --cwd', async () => {
    const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-relative-bun-config-')));
    const project = join(dir, 'project');
    const home = join(dir, 'home');
    const marker = join(project, 'executed');
    mkdirSync(home);
    mkdirSync(join(project, '.archon', 'workflows'), { recursive: true });
    writeFileSync(join(dir, 'config.toml'), '');
    writeFileSync(join(home, 'config.yaml'), 'store: files\n');
    writeFileSync(
      join(project, '.archon', 'workflows', 'finish.yaml'),
      `name: finish
description: Relative Bun config fixture
worktree:
  enabled: false
nodes:
  - id: finish
    runtime: bun
    script: ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done');`)}
`
    );
    const child = Bun.spawn(
      [
        process.execPath,
        '--config=./config.toml',
        join(import.meta.dir, '..', 'cli.ts'),
        'workflow',
        'run',
        'finish',
        '--folder',
        '--detach',
        '--json',
        '--cwd',
        project,
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          ARCHON_HOME: home,
          ARCHON_TELEMETRY_DISABLED: '1',
          DATABASE_URL: '',
          BUN_OPTIONS: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, stdout + stderr).toBe(0);
    const ack: { runId: string } = JSON.parse(stdout);
    const store = await createFileWorkflowStore({ root: join(home, 'store') });
    const deadline = Date.now() + 15_000;
    while ((await store.getWorkflowRun(ack.runId))?.status !== 'completed') {
      if (Date.now() >= deadline) throw new Error('Detached executor did not complete');
      await Bun.sleep(25);
    }
    expect(existsSync(marker)).toBe(true);
  }, 30_000);

  it('kills a broker that never becomes ready and reports its stderr', async () => {
    const broker = await bootBrokerStub(
      "console.error('startup stuck'); setInterval(() => {}, 1000)"
    );
    const exited = new Promise<void>(resolve => broker.once('exit', () => resolve()));
    try {
      const ready = waitForRunJobEscapeBroker(broker, 500);
      broker.stdin.write('start');
      await expect(ready).rejects.toThrow('startup stuck');
      expect(broker.killed).toBe(true);
      await exited;
    } finally {
      broker.kill();
    }
  });

  it('reports an early broker exit with stderr', async () => {
    const broker = await bootBrokerStub("console.error('startup failed'); process.exit(7)");
    const ready = waitForRunJobEscapeBroker(broker, 1_000);
    broker.stdin.write('start');
    await expect(ready).rejects.toThrow('startup failed');
  });

  it('clears the startup deadline when the broker becomes ready', async () => {
    const broker = await bootBrokerStub(
      "console.log('ready'); setTimeout(() => process.exit(0), 200)"
    );
    const exited = new Promise<number | null>(resolve => broker.once('exit', resolve));
    const ready = waitForRunJobEscapeBroker(broker, 100);
    broker.stdin.write('start');
    await ready;
    expect(await exited).toBe(0);
    expect(broker.killed).toBe(false);
  });

  it('relays only detached launches', () => {
    expect(isDetachedLaunch(['workflow', 'run', 'build', '--detach', '--json'])).toBe(true);
    expect(isDetachedLaunch(['workflow', 'run', 'build', 'ship --detach later'])).toBe(false);
    expect(isDetachedLaunch(['workflow', 'run', 'build', '--', '--detach'])).toBe(false);
    expect(isDetachedLaunch(['trigger', 'fire', '--detach'])).toBe(false);
  });
});
