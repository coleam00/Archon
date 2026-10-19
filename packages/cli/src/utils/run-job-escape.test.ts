import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
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

  it('keeps serving after a client dies mid-invocation', async () => {
    const pipe = brokerPipe();
    const server = await serveRunJobEscape(pipe);
    try {
      // A launcher killed while its command still writes output leaves the broker writing
      // to a dead connection.
      const client = createConnection(pipe);
      await new Promise<void>(resolveConnect => client.once('connect', resolveConnect));
      client.write(
        `${JSON.stringify({
          argv: [
            process.execPath,
            '-e',
            'const t = setInterval(() => console.log("x".repeat(65536)), 5); setTimeout(() => { clearInterval(t); }, 500);',
          ],
          cwd: process.cwd(),
          env: { ...process.env },
        })}\n`
      );
      await Bun.sleep(100);
      client.resetAndDestroy();
      await Bun.sleep(600);

      const exit = await relayOutsideRunJob(
        pipe,
        {
          argv: [process.execPath, '-e', 'process.exit(0)'],
          cwd: process.cwd(),
          env: { ...process.env },
        },
        { stdout: async () => {}, stderr: async () => {} }
      );
      expect(exit).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('relays only detached launches', () => {
    expect(isDetachedLaunch(['workflow', 'run', 'build', '--detach', '--json'])).toBe(true);
    expect(isDetachedLaunch(['workflow', 'run', 'build', 'ship --detach later'])).toBe(false);
    expect(isDetachedLaunch(['workflow', 'run', 'build', '--', '--detach'])).toBe(false);
  });
});
