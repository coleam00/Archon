import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileAsync, resolveBashPath } from '@archon/git';
import { trackTempRoots } from '@archon/paths/test-utils';
import { bashScriptArgs } from './bash-script';

const trackTempRoot = trackTempRoots();

test('executes large scripts from the engine directory under run artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archon-bash-script-'));
  trackTempRoot(root);
  const artifacts = join(root, 'artifacts');
  const other = join(root, 'other');
  await mkdir(other);
  const script = `value='${'é'.repeat(100_000)}'; printf '%s' "$value"`;
  const args = bashScriptArgs(script, artifacts);
  expect(args).toHaveLength(1);
  expect(dirname(args[0])).toBe(join(artifacts, '.archon', 'bash-scripts'));
  expect(await readFile(args[0], 'utf8')).toBe(script);
  const { stdout } = await execFileAsync(resolveBashPath(), args, { cwd: other });
  expect(stdout).toBe('é'.repeat(100_000));
});
