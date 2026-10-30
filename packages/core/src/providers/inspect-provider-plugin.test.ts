// @archon-test-isolated
import { describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pluginProcess from '@archon/paths/plugin-process';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  PluginProtocolMismatchError,
  PROVIDER_PLUGIN_PROTOCOL,
} from '@archon/provider-contract/plugin';
import { inspectProviderPlugin } from './inspect-provider-plugin';

const trackTempRoot = trackTempRoots();
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

describe.skipIf(process.platform === 'win32')('provider inspection cleanup', () => {
  function fixture(): string {
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-inspect-provider-')));
    const executable = join(root, "plugin ' launcher");
    const peer = join(import.meta.dir, 'fixtures/process-provider.ts');
    writeFileSync(
      executable,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(peer)} protocol\n`,
      { mode: 0o755 }
    );
    return executable;
  }

  async function expectInspection(executable: string): Promise<void> {
    const error: unknown = await inspectProviderPlugin(executable).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(PluginProtocolMismatchError);
    expect(error).toMatchObject({
      hostProtocol: PROVIDER_PLUGIN_PROTOCOL,
      pluginProtocol: PROVIDER_PLUGIN_PROTOCOL + 1,
    });
    expect(String(error)).not.toContain('EPERM');
    expect(String(error)).not.toContain('cleanup failed');
  }

  test('preserves the initialize error after stdin EOF and child exit before cleanup', async () => {
    const executable = fixture();
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
    const executable = fixture();
    for (let attempt = 0; attempt < (process.platform === 'darwin' ? 40 : 1); attempt++) {
      await expectInspection(executable);
    }
  });
});
