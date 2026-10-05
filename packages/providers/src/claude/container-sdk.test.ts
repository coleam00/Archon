import { expect, test } from 'bun:test';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();

test('container queries reach the real SDK spawn hook without a host platform binary', async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-container-sdk-')));
  const sdkDir = join(root, 'sdk');
  await cp(dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))), sdkDir, {
    recursive: true,
  });
  const sdkUrl = pathToFileURL(join(sdkDir, 'sdk.mjs')).href;
  const providerUrl = new URL('./provider.ts', import.meta.url).href;
  const spawnUrl = new URL('./container-spawn.ts', import.meta.url).href;
  // The isolated SDK has no platform package; --no-install prevents Bun's cache
  // from supplying one and hiding the compiled-binary failure (#2526).
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      '--eval',
      `
        import { mock } from 'bun:test';
        import assert from 'node:assert/strict';
        const sdk = await import(${JSON.stringify(sdkUrl)});
        let hookCalled = false;
        const hook = () => {
          hookCalled = true;
          throw new Error('container-spawn-hook-reached');
        };
        assert.throws(() => sdk.query({
          prompt: 'test',
          options: { cwd: ${JSON.stringify(root)}, spawnClaudeCodeProcess: hook },
        }), /Native CLI binary/);
        assert.equal(hookCalled, false);
        mock.module('@anthropic-ai/claude-agent-sdk', () => sdk);
        const spawn = await import(${JSON.stringify(spawnUrl)});
        mock.module(${JSON.stringify(spawnUrl)}, () => ({ ...spawn, buildContainerSpawn: () => hook }));
        const { ClaudeProvider } = await import(${JSON.stringify(providerUrl)});
        for await (const chunk of new ClaudeProvider().sendQuery('test', ${JSON.stringify(root)}, undefined, {
          execContext: { kind: 'container', containerId: 'test-container' },
        })) {}
        assert.equal(hookCalled, true, 'provider must reach container spawn without resolving a host binary');
      `,
    ],
    {
      cwd: root,
      env: { ...process.env, CLAUDE_BIN_PATH: join(root, 'missing-host-claude') },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, output: exitCode === 0 ? '' : stdout + stderr }).toEqual({
    exitCode: 0,
    output: '',
  });
});
