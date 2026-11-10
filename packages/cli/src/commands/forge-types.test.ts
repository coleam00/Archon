/**
 * `archon forge types`: the generated file type-checks a caller against the forge
 * contract, its client reads the host's answers, and check mode notices a stale file.
 */
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { trackTempRoots } from '@archon/paths/test-utils';
import { forgeTypesCommand } from './forge-types';

const trackTempRoot = trackTempRoots();
const REPO_TYPES = join(import.meta.dir, '../../../../node_modules/@types');

async function generate(): Promise<string> {
  const root = trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'archon-forge-types-'))));
  expect(await forgeTypesCommand(root, { out: 'forge.generated.ts', json: true })).toBe(0);
  return root;
}

test('a script calling the generated client is checked against the forge schemas', async () => {
  const root = await generate();
  const script = join(root, 'script.ts');
  writeFileSync(
    script,
    `import { ForgeOperationError, invokeForge } from './forge.generated';
const repo = { host: 'forge.example', path: 'team/repo' };
const view = invokeForge('pr.view', { selector: { kind: 'number', ref: { repo, number: 7 } } });
export const head: string | undefined = view?.pr.head;
export const state: 'open' | 'closed' | 'merged' | undefined = view?.pr.state;
// @ts-expect-error a selector kind the forge does not define
invokeForge('pr.view', { selector: { kind: 'title', title: 'x' } });
// @ts-expect-error an operation the forge does not define
invokeForge('pr.delete', {});
// @ts-expect-error a result field the forge does not return
export const missing = view?.pr.nope;
export function outcome(error: unknown): 'refused' | 'verification_failed' | 'outcome_unknown' | undefined {
  return error instanceof ForgeOperationError && error.kind !== 'timeout' ? error.mutation?.outcome : undefined;
}
`
  );
  const program = ts.createProgram([script], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    typeRoots: [REPO_TYPES],
    types: ['bun'],
  });
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  expect(diagnostics).toEqual([]);
});

test('the generated client returns a result and throws the typed failure of a write', async () => {
  const root = await generate();
  const host = join(root, 'host.ts');
  // Stands in for `archon forge <op> --json --data-file <path>`: answers from the request it was handed.
  writeFileSync(
    host,
    `const [, op, , , path] = process.argv.slice(2);
const request = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
const answer = request.fail
  ? { operationId: 'x', ok: false, error: { kind: 'conflict', message: 'head moved' },
      mutation: { op, target: request.ref, outcome: 'refused' } }
  : { operationId: 'x', ok: true, result: { op, value: { echoed: request } } };
process.stdout.write(JSON.stringify(answer));
process.exit(request.exit ?? (answer.ok ? 0 : 1));
`
  );
  const previous = process.env.ARCHON_CLI_COMMAND;
  process.env.ARCHON_CLI_COMMAND = JSON.stringify([process.execPath, '--no-env-file', host]);
  try {
    const client: {
      invokeForge: (op: string, request: object) => unknown;
      ForgeOperationError: new (...args: never[]) => Error;
    } = await import(join(root, 'forge.generated.ts'));
    const ref = { repo: { host: 'forge.example', path: 'team/repo' }, number: 7 };
    expect(client.invokeForge('pr.ready', { ref })).toEqual({ echoed: { ref } });
    // Exit 2 with a result is a completed operation the host could not audit.
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(client.invokeForge('pr.ready', { ref, exit: 2 })).toEqual({
        echoed: { ref, exit: 2 },
      });
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
    }
    let thrown: unknown;
    try {
      client.invokeForge('pr.ready', { ref, fail: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(client.ForgeOperationError);
    expect(thrown).toMatchObject({
      op: 'pr.ready',
      kind: 'conflict',
      message: 'forge pr.ready refused: head moved',
      mutation: { outcome: 'refused', target: ref },
    });
  } finally {
    if (previous === undefined) delete process.env.ARCHON_CLI_COMMAND;
    else process.env.ARCHON_CLI_COMMAND = previous;
  }
});

test('check mode exits 1 for a missing or edited file and writes nothing', async () => {
  const root = trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'archon-forge-types-'))));
  const path = join(root, 'forge.generated.ts');
  const check = (): Promise<number> =>
    forgeTypesCommand(root, { out: 'forge.generated.ts', check: true, json: true });
  expect(await check()).toBe(1);
  expect(() => readFileSync(path)).toThrow();
  expect(await forgeTypesCommand(root, { out: 'forge.generated.ts', json: true })).toBe(0);
  expect(await check()).toBe(0);
  const stale = readFileSync(path, 'utf8').replace("'pr.view'", "'pr.look'");
  writeFileSync(path, stale);
  expect(await check()).toBe(1);
  expect(readFileSync(path, 'utf8')).toBe(stale);
});
