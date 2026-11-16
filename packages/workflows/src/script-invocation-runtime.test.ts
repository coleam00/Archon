// @archon-test-isolated
import { expect, test } from 'bun:test';
import { execFileAsync } from '@archon/git';
import { removeTempTree } from '@archon/paths/test-utils';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptInvocation } from './script-invocation';
import { recordNodeProcessTrees, runSubprocess } from './subprocess';

const launchModes = ['dry run', 'unrecorded executor', 'recorded executor'] as const;

test.each([...launchModes])('inline Bun preserves script behavior in %s', async mode => {
  await checkInlineScript(mode, false);
});

test.skipIf(process.platform !== 'win32').each([...launchModes])(
  'inline Bun receives multiline source through a Windows PATH shim in %s',
  async mode => {
    await checkInlineScript(mode, true);
  }
);

async function checkInlineScript(mode: (typeof launchModes)[number], shim: boolean): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'archon-inline bun-'));
  const trees = mode === 'recorded executor' ? recordNodeProcessTrees() : undefined;
  const inheritedCanary = process.env.ARCHON_INLINE_ENV_CANARY;
  delete process.env.ARCHON_INLINE_ENV_CANARY;
  try {
    await writeFile(join(dir, 'value.ts'), 'export const value: string = "relative import";');
    await writeFile(join(dir, '.env'), 'ARCHON_INLINE_ENV_CANARY=loaded\n');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      INPUTS_MESSAGE: 'input € & | <> % ! ^ "',
      ARCHON_INLINE_SHIM: '',
    };
    const invocation = scriptInvocation(
      'bun',
      {
        kind: 'inline',
        code: [
          'import { value } from "./value.ts";',
          'const message: string = await Promise.resolve(process.env.INPUTS_MESSAGE!);',
          "const literal: string = 'source € & | <> % ! ^ \" `';",
          'console.log(JSON.stringify({ value, message, literal, canary: process.env.ARCHON_INLINE_ENV_CANARY, shim: process.env.ARCHON_INLINE_SHIM }));',
        ].join('\r\n'),
      },
      [],
      join(dir, 'artifacts')
    );
    let command = process.execPath;
    if (shim) {
      await writeFile(
        join(dir, 'bun.cmd'),
        `@set ARCHON_INLINE_SHIM=visited\r\n@"${process.execPath}" %*\r\n`
      );
      env.PATH = dir;
      command = invocation.command;
      // Explicit .cmd paths are rejected by Bun's Node API; workflows resolve bare bun on PATH.
      expect(Bun.which(command, { PATH: env.PATH })).toBe(join(dir, 'bun.cmd'));
    }
    const options = { cwd: dir, env, input: invocation.input, timeout: 5000 };
    const result =
      mode === 'dry run'
        ? await execFileAsync(command, invocation.args, options)
        : await runSubprocess({ kind: 'host' }, command, invocation.args, {
            ...options,
            endTreeOnTimeout: true,
            retention: { standalone: true },
          });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      value: 'relative import',
      message: env.INPUTS_MESSAGE,
      literal: 'source € & | <> % ! ^ " `',
      shim: shim ? 'visited' : '',
    });
  } finally {
    if (inheritedCanary !== undefined) process.env.ARCHON_INLINE_ENV_CANARY = inheritedCanary;
    else delete process.env.ARCHON_INLINE_ENV_CANARY;
    trees?.release();
    await removeTempTree(dir);
  }
}

test.skipIf(!Bun.which('uv'))(
  'inline uv runs outside the checkout uv project, config and Python pin',
  async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'archon-uv-checkout-'));
    const artifactsDir = await mkdtemp(join(tmpdir(), 'archon-uv-artifacts-'));
    try {
      // Each planted file fails the node if uv reads it.
      await writeFile(
        join(checkout, 'pyproject.toml'),
        [
          '[project]',
          'name = "checkout"',
          'version = "0.0.0"',
          'requires-python = ">=3.99"',
          'dependencies = ["archon-nonexistent-dependency"]',
          '',
          '[tool.uv]',
          'index-url = "http://127.0.0.1:9/simple"',
          '',
        ].join('\n')
      );
      await writeFile(join(checkout, '.python-version'), '3.99\n');
      const invocation = scriptInvocation(
        'uv',
        { kind: 'inline', code: 'print("ok")' },
        [],
        artifactsDir
      );
      const result = await execFileAsync(invocation.command, invocation.args, {
        cwd: checkout,
        timeout: 60_000,
      });
      expect(result.stdout.trim()).toBe('ok');
      expect(existsSync(join(checkout, '.venv'))).toBe(false);
      expect(existsSync(join(checkout, 'uv.lock'))).toBe(false);
    } finally {
      await removeTempTree(checkout);
      await removeTempTree(artifactsDir);
    }
  },
  60_000
);
