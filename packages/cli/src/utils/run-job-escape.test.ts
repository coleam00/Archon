import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
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
} from './run-job-escape';

const trackTempRoot = trackTempRoots();

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
    const server = await serveRunJobEscape(pipe);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    try {
      const exit = await relayOutsideRunJob(
        pipe,
        {
          argv: [
            process.execPath,
            '-e',
            `console.log(JSON.stringify(process.env.${RUN_JOB_ESCAPE_ENV} ?? null)); console.error('relayed'); process.exit(3);`,
          ],
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
    let failFirst = true;
    // A launcher killed mid-invocation surfaces on the broker as an error on its connection.
    const server = createServer(socket => {
      acceptRelayConnection(socket);
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
          { argv: [process.execPath, '-e', 'process.exit(0)'], cwd: process.cwd(), env: {} },
          { stdout: async () => {}, stderr: async () => {} }
        );
      await expect(relay()).rejects.toThrow();
      expect(await relay()).toBe(0);
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });

  it('relays only detached launches', () => {
    expect(isDetachedLaunch(['workflow', 'run', 'build', '--detach', '--json'])).toBe(true);
    expect(isDetachedLaunch(['workflow', 'run', 'build', 'ship --detach later'])).toBe(false);
    expect(isDetachedLaunch(['workflow', 'run', 'build', '--', '--detach'])).toBe(false);
  });
});
