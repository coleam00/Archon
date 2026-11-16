// @archon-test-isolated
import { expect, test } from 'bun:test';
import { execFileAsync } from '@archon/git';
import { removeTempTree } from '@archon/paths/test-utils';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

// Builds a one-module wheel and a PEP 503 index for it, so the install needs no network.
const buildIndex = `
import base64, hashlib, os, sys, zipfile
root = sys.argv[1]
files = {
    'archon_probe_dep.py': 'VALUE = "installed"\\n',
    'archon_probe_dep-1.0.dist-info/METADATA': 'Metadata-Version: 2.1\\nName: archon-probe-dep\\nVersion: 1.0\\n',
    'archon_probe_dep-1.0.dist-info/WHEEL': 'Wheel-Version: 1.0\\nGenerator: archon-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n',
}
def digest(text):
    return base64.urlsafe_b64encode(hashlib.sha256(text.encode()).digest()).rstrip(b'=').decode()
record = ''.join(f'{name},sha256={digest(text)},{len(text.encode())}\\n' for name, text in files.items())
files['archon_probe_dep-1.0.dist-info/RECORD'] = record + 'archon_probe_dep-1.0.dist-info/RECORD,,\\n'
wheel = 'archon_probe_dep-1.0-py3-none-any.whl'
with zipfile.ZipFile(os.path.join(root, wheel), 'w') as archive:
    for name, text in files.items():
        archive.writestr(name, text)
os.makedirs(os.path.join(root, 'simple', 'archon-probe-dep'))
with open(os.path.join(root, 'simple', 'archon-probe-dep', 'index.html'), 'w') as page:
    page.write(f'<a href="../../{wheel}">{wheel}</a>\\n')
`;

test.skipIf(!Bun.which('uv'))(
  'uv installs a dependency named in deps',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-uv-deps-'));
    try {
      const checkout = join(dir, 'checkout');
      const index = join(dir, 'index');
      const config = join(dir, 'config');
      await Promise.all(
        [checkout, index, join(config, 'uv')].map(d => mkdir(d, { recursive: true }))
      );
      // A scratch user config (XDG on Unix, APPDATA on Windows) points uv at the local index,
      // and a scratch cache keeps a previous install from satisfying this one.
      const env = {
        ...process.env,
        XDG_CONFIG_HOME: config,
        APPDATA: config,
        UV_CACHE_DIR: join(dir, 'cache'),
      };
      await execFileAsync('uv', ['run', '--no-project', 'python', '-c', buildIndex, index], {
        cwd: dir,
        env,
        timeout: 60_000,
      });
      await writeFile(
        join(config, 'uv', 'uv.toml'),
        `index-url = ${JSON.stringify(pathToFileURL(join(index, 'simple')).href)}\n`
      );
      const invocation = scriptInvocation(
        'uv',
        { kind: 'inline', code: 'import archon_probe_dep; print(archon_probe_dep.VALUE)' },
        ['archon-probe-dep'],
        join(dir, 'artifacts')
      );
      const result = await execFileAsync(invocation.command, invocation.args, {
        cwd: checkout,
        env,
        timeout: 60_000,
      });
      expect(result.stdout.trim()).toBe('installed');
    } finally {
      await removeTempTree(dir);
    }
  },
  60_000
);
