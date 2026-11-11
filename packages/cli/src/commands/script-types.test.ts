/**
 * `archon script types`: writes the declaration the engine embeds, and check mode
 * notices a missing or edited file without touching it.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { scriptApiDeclaration } from '@archon/workflows/script-api';
import { scriptTypesCommand } from './script-types';

const trackTempRoot = trackTempRoots();

test('writes the embedded declaration, and check mode exits 1 for a missing or edited file', async () => {
  const root = trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'archon-script-types-'))));
  const path = join(root, 'types', 'archon-script.d.ts');
  const run = (check: boolean): Promise<number> =>
    scriptTypesCommand(root, { out: 'types/archon-script.d.ts', check, json: true });

  expect(await run(true)).toBe(1);
  expect(() => readFileSync(path)).toThrow();
  expect(await run(false)).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(scriptApiDeclaration);
  expect(scriptApiDeclaration).toContain("declare module 'archon:script'");
  expect(await run(true)).toBe(0);

  const stale = scriptApiDeclaration.replace("'pr.view'", "'pr.look'");
  writeFileSync(path, stale);
  expect(await run(true)).toBe(1);
  expect(readFileSync(path, 'utf8')).toBe(stale);
});
