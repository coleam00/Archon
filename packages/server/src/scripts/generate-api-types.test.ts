/**
 * Tests for the `--check` guard in `generate-api-types.ts` (#2586).
 *
 * The contract under test is the decision: stale content is rejected, an
 * equivalent CRLF checkout is not, and check mode leaves the file alone. That
 * decision is exercised in-process against a temp fixture.
 *
 * These used to drive the CLI as a subprocess, which timed out at Bun's 5000 ms
 * default on both ubuntu and windows runners (#2931). The spawn regenerated the
 * types in full to produce a value the test then contradicted by appending to
 * the file: prettier alone was ~1470 ms of it, the openapi-typescript child
 * ~270 ms and loading the route tree ~245 ms, while the comparison being
 * verified took ~3 ms. Regenerating is what `bun run check:api-types` does as
 * its own CI step and in `validate`, so the generator and its exit codes stay
 * covered there; repeating it here bought only the handful of lines that
 * translate the outcome below into a message and `process.exit(2)`.
 *
 * The old shape also mutated the committed `api.generated.d.ts`, restoring it in
 * a `finally` that has to win a race against the timeout it was hitting. Losing
 * that race leaves the file dirty for whatever runs next. A temp fixture removes
 * the question.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { removeTempTree } from '@archon/paths/test-utils';
import { applyApiTypes, runOpenApiGenerator } from './generate-api-types';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(removeTempTree));
});

async function fixture(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'archon-api-types-'));
  tempRoots.push(root);
  const outputPath = join(root, 'api.generated.d.ts');
  await writeFile(outputPath, contents);
  return outputPath;
}

test('check rejects stale API types without rewriting them', async () => {
  const stale = 'export interface paths {}\n// stale test declaration\n';
  const outputPath = await fixture(stale);

  const outcome = await applyApiTypes({
    outputPath,
    generated: 'export interface paths {}\n',
    checkOnly: true,
  });

  expect(outcome).toBe('stale');
  expect(await readFile(outputPath, 'utf8')).toBe(stale);
});

test('check accepts API types that match the generator', async () => {
  const generated = 'export interface paths {}\n';
  const outputPath = await fixture(generated);

  expect(await applyApiTypes({ outputPath, generated, checkOnly: true })).toBe('ok');
  expect(await readFile(outputPath, 'utf8')).toBe(generated);
});

test('check accepts a CRLF checkout of equivalent types', async () => {
  const crlf = 'export interface paths {}\r\ntype Id = string;\r\n';
  const outputPath = await fixture(crlf);

  const outcome = await applyApiTypes({
    outputPath,
    generated: 'export interface paths {}\ntype Id = string;\n',
    checkOnly: true,
  });

  expect(outcome).toBe('ok');
  expect(await readFile(outputPath, 'utf8')).toBe(crlf);
});

test('generate mode writes the types', async () => {
  const generated = 'export interface paths {}\n';
  const outputPath = await fixture('// outdated\n');

  expect(await applyApiTypes({ outputPath, generated, checkOnly: false })).toBe('written');
  expect(await readFile(outputPath, 'utf8')).toBe(generated);
});

// The one deliberate subprocess in this file, and it is bounded by the thing
// under test: a child that genuinely never exits, killed at 250ms. What the
// docblock above removed was the cost of regenerating the types, not spawning as
// such — and a bound proved against a fake subprocess would only be proving that
// the fake models kill-ends-the-wait, which is the part worth doubting.
//
// `bun run check:api-types` runs this generator inside `bun run validate` and on
// every windows CI leg, with nothing else to end a stalled child.
test('the generator bound kills a stalled child, names the timeout, and unstages the schema', async () => {
  const realSpawn = Bun.spawn.bind(Bun);
  let stagedStdin: unknown;
  const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((
    _command: string[],
    options: Parameters<typeof Bun.spawn>[1]
  ) => {
    stagedStdin = options?.stdin;
    return realSpawn([process.execPath, '-e', 'await new Promise(() => {})'], options);
  }) as unknown as typeof Bun.spawn);

  try {
    await expect(runOpenApiGenerator('{"openapi":"3.1.0"}', 250)).rejects.toThrow(
      /Timed out generating API types: openapi-typescript .* did not finish within 250ms/
    );
  } finally {
    spawnSpy.mockRestore();
  }

  // A BunFile is a Blob; the `Uint8Array` this replaced is not. That array form
  // is the parent-pumped channel that hung `archon serve` on windows (#2924).
  expect(stagedStdin).toBeInstanceOf(Blob);
  const stagedPath = (stagedStdin as { name?: string }).name;
  expect(stagedPath).toBeTruthy();
  expect(existsSync(stagedPath as string)).toBe(false);
});
