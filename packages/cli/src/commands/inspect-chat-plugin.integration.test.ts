// @archon-test-isolated
import { describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pluginProcess from '@archon/paths/plugin-process';
import { trackTempRoots } from '@archon/paths/test-utils';
import { inspectChatPlugin } from './inspect-chat-plugin';

const trackTempRoot = trackTempRoots();
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

describe.skipIf(process.platform === 'win32')('chat inspection cleanup', () => {
  function fixture(): { executable: string; eof: string } {
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-inspect-chat-')));
    const executable = join(root, "plugin ' launcher");
    const eof = join(root, 'eof');
    const peer = join(root, 'peer.ts');
    writeFileSync(
      peer,
      `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
    error: { code: -32000, message: 'secret-initialize-sentinel' } }) + '\\n');
});
input.on('close', () => { writeFileSync(${JSON.stringify(eof)}, 'EOF'); process.exit(0); });
`
    );
    writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(peer)}\n`, {
      mode: 0o755,
    });
    return { executable, eof };
  }

  async function expectInspection(executable: string): Promise<void> {
    const error: unknown = await inspectChatPlugin(executable).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('failed initialize');
    expect(String(error)).not.toContain('secret-initialize-sentinel');
    expect(String(error)).not.toContain('EPERM');
    expect(String(error)).not.toContain('cleanup failed');
  }

  test('preserves the initialize error after stdin EOF and child exit before cleanup', async () => {
    const { executable, eof } = fixture();
    const nativeSpawn = childProcess.spawn;
    const realStop = pluginProcess.terminateTree;
    let exited: Promise<unknown> | undefined;
    const spawn = spyOn(childProcess, 'spawn').mockImplementation(
      new Proxy(nativeSpawn, {
        apply(target, _receiver, args: Parameters<typeof nativeSpawn>) {
          const child = target(...args);
          exited = once(child, 'exit');
          return child;
        },
      })
    );
    const stop = spyOn(pluginProcess, 'terminateTree').mockImplementation(async (pid, signal) => {
      expect(exited).toBeDefined();
      expect(await exited).toEqual([0, null]);
      expect(readFileSync(eof, 'utf8')).toBe('EOF');
      await realStop(pid, signal);
    });
    try {
      await expectInspection(executable);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      stop.mockRestore();
      spawn.mockRestore();
    }
  });

  test('preserves initialize diagnostics across repeated normal macOS inspections', async () => {
    const { executable } = fixture();
    for (let attempt = 0; attempt < (process.platform === 'darwin' ? 40 : 1); attempt++) {
      await expectInspection(executable);
    }
  });
});
