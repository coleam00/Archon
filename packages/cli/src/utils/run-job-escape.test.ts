import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
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
    `console.log(JSON.stringify(process.env.${RUN_JOB_ESCAPE_ENV} ?? null)); console.error('relayed'); process.exit(3);`
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
          env: { ...process.env, [RUN_JOB_ESCAPE_ENV]: pipe },
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
      expect(Buffer.concat(stdout).toString()).toBe('null\n');
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
