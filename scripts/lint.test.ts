import { expect, it } from 'bun:test';
import { copyFile, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const REPO_ROOT = resolve(import.meta.dir, '..');
const trackTempRoot = trackTempRoots();

async function createFixture(): Promise<string> {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-typed-lint-')));
  for (const directory of ['bin', '.archon/scripts', '.archon/workflows', 'packages/fixture/src']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  // The wrapper sits outside every lint target so each pass type-checks only the two
  // fixture files. Linting the wrapper too put bun-types into every program, and the
  // cold first case on windows-latest took 17-26 s instead of 12-13 s.
  await copyFile(join(REPO_ROOT, 'scripts/lint.ts'), join(root, 'bin/lint.ts'));
  for (const file of [
    'eslint.config.mjs',
    '.archon/scripts/tsconfig.json',
    '.archon/workflows/tsconfig.json',
  ]) {
    await copyFile(join(REPO_ROOT, file), join(root, file));
  }
  await symlink(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'junction');
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, lib: ['es2022'], types: [] },
      include: ['packages/fixture/src/**/*.ts'],
    })
  );
  await writeFile(
    join(root, 'packages/fixture/src/consumer.ts'),
    "import type { Handler } from './types';\nexport function callback(handler: Handler): () => void {\n  return handler.callback;\n}\n"
  );
  return root;
}

async function lint(
  root: string,
  args: readonly string[]
): Promise<{ code: number; output: string }> {
  const child = Bun.spawn([process.execPath, 'run', 'bin/lint.ts', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

it.each([{ args: [] }, { args: ['--cache'] }, { args: ['--fix', '--cache'] }])(
  'refreshes imported-type diagnostics with forwarded args %j',
  async ({ args }) => {
    const root = await createFixture();
    const types = join(root, 'packages/fixture/src/types.ts');
    const method = 'export interface Handler { callback(): void; }\n';
    await writeFile(types, method);
    const initial = await lint(root, args);
    expect(initial.code).toBe(1);
    expect(initial.output).toContain('@typescript-eslint/unbound-method');

    await writeFile(types, 'export interface Handler { callback: () => void; }\n');
    const cleared = await lint(root, args);
    expect(cleared.output).not.toContain('@typescript-eslint/unbound-method');
    expect(cleared.code).toBe(0);

    await writeFile(types, method);
    const restored = await lint(root, args);
    expect(restored.code).toBe(1);
    expect(restored.output).toContain('@typescript-eslint/unbound-method');
  },
  30_000
);
