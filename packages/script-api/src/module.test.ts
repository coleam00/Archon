// @archon-test-isolated
/**
 * The `archon:script` module over a stand-in host CLI: what it sends, how it reads the
 * host's answers and exit codes, and that its declaration type-checks a script that has
 * nothing but the declaration file.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { removeTempTree } from '@archon/paths/test-utils';
import { ForgeError, forge, HostCommandError, state, trigger } from './module';
import { scriptApiDeclaration } from './text';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-script-api-')));
const previous = process.env.ARCHON_CLI_COMMAND;

beforeAll(() => {
  const host = join(root, 'host.ts');
  // Stands in for `archon`: answers each command from the arguments and input it was handed.
  writeFileSync(
    host,
    `import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const [command, sub] = args;
const answer = (value: unknown, code = 0): void => {
  process.stdout.write(JSON.stringify(value));
  process.exitCode = code;
};
if (command === 'forge') {
  const request = JSON.parse(readFileSync(args.at(-1)!, 'utf8'));
  if (request.silent) process.exitCode = 1;
  else if (request.fail)
    answer({ operationId: 'x', ok: false, error: { kind: 'conflict', message: 'head moved' },
      mutation: { op: sub, target: request.ref, outcome: 'refused' } }, 1);
  else answer({ operationId: 'x', ok: true, result: { op: sub, value: { echoed: request } } }, request.exit ?? 0);
} else if (command === 'state' && args.includes('--held')) {
  answer({ ok: false, error: 'not held', code: 3, reason: 'lease_not_held' }, 3);
} else if (command === 'state' && sub === 'claim') {
  answer({ claimed: null, skipped: [{ name: 'a', reason: 'missing' }] }, 2);
} else if (command === 'state') {
  answer({ name: args[2], revision: 4, args: args.slice(3), stdin: await Bun.stdin.text() });
} else if (command === 'trigger') {
  const inputs = readFileSync(args[args.indexOf('--inputs') + 1]!, 'utf8');
  answer({ id: 'receipt-1', args: args.slice(2, 6), bindings: [{ disposition: { status: 'admitted', requestId: 'q', runId: inputs } }] });
}
`
  );
  process.env.ARCHON_CLI_COMMAND = JSON.stringify([process.execPath, '--no-env-file', host]);
});

afterAll(async () => {
  await removeTempTree(root);
  if (previous === undefined) delete process.env.ARCHON_CLI_COMMAND;
  else process.env.ARCHON_CLI_COMMAND = previous;
});

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

const ref = { repo: { host: 'forge.example', path: 'team/repo' }, number: 7 };

test('forge returns the result, and a completed operation the host could not audit', () => {
  expect(forge('pr.ready', { ref })).toEqual({ echoed: { ref } } as never);
  const stderr = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(forge('pr.ready', { ref, exit: 2 } as never)).toEqual({
      echoed: { ref, exit: 2 },
    } as never);
    expect(stderr).toHaveBeenCalledTimes(1);
  } finally {
    stderr.mockRestore();
  }
});

test('a forge failure is the typed error with its kind and what is known of the write', () => {
  const failure = thrownBy(() => forge('pr.ready', { ref, fail: true } as never));
  expect(failure).toBeInstanceOf(ForgeError);
  expect(failure).toMatchObject({
    op: 'pr.ready',
    kind: 'conflict',
    message: 'forge pr.ready refused: head moved',
    mutation: { outcome: 'refused', target: ref },
  });
  // No answer at all is a different error: the write may or may not have happened.
  const silent = thrownBy(() => forge('pr.ready', { ref, silent: true } as never));
  expect(silent).toBeInstanceOf(HostCommandError);
  expect(silent).toMatchObject({ command: 'forge pr.ready', exitCode: 1 });
});

test('state writes send their conditions and report a refusal by its reason', () => {
  expect(state.put('queue/a', { n: 1 }, { ifRevision: 3, lease: 'take' })).toEqual({
    ok: true,
    revision: {
      name: 'queue/a',
      revision: 4,
      args: ['--if-revision', '3', '--lease'],
      stdin: '{"n":1}',
    } as never,
  });
  expect(
    state.patch('queue/a', [{ op: 'append', path: '/log', value: 1 }], { held: true })
  ).toEqual({ ok: false, conflict: 'lease_not_held' });
  // Nothing claimable is an answer, not a failure.
  expect(state.claim([{ name: 'a', ifRevision: 1 }])).toEqual({
    claimed: null,
    skipped: [{ name: 'a', reason: 'missing' }],
  });
});

test('trigger.fire hands the binding its inputs in a stable order and returns the admission', () => {
  expect(trigger.fire('/bindings/next.json', { b: 2, a: 1 }, { deliveryId: 'pr-7' })).toEqual({
    receiptId: 'receipt-1',
    disposition: { status: 'admitted', requestId: 'q', runId: '{"a":1,"b":2}' },
  });
});

test('the declaration alone type-checks a script against the forge and state contracts', () => {
  const declaration = join(root, 'archon-script.d.ts');
  const script = join(root, 'script.ts');
  writeFileSync(declaration, scriptApiDeclaration);
  writeFileSync(
    script,
    `import { ForgeError, forge, input, outcomes, state, trigger } from 'archon:script';
const repo = { host: 'forge.example', path: 'team/repo' };
const view = forge('pr.view', { selector: { kind: 'number', ref: { repo, number: 7 } } });
export const head: string | undefined = view?.pr.head;
export const name: string = input('name');
// @ts-expect-error a request field the forge does not define
forge('pr.view', { selector: { kind: 'title', title: 'x' } });
// @ts-expect-error an operation the forge does not define
forge('pr.delete', {});
// @ts-expect-error a result field the forge does not return
export const missing = view?.pr.nope;
export function outcome(error: unknown): 'refused' | 'verification_failed' | 'outcome_unknown' | undefined {
  return error instanceof ForgeError && error.kind !== 'timeout' ? error.mutation?.outcome : undefined;
}
const written = state.put('queue/a', {}, { ifRevision: 0 });
export const conflict: 'revision_conflict' | 'lease_held' | 'lease_not_held' | number = written.ok
  ? written.revision.revision
  : written.conflict;
// @ts-expect-error a put names the revision it replaces
state.put('queue/a', {});
export const states: string[] = outcomes().nodes.map(node => node.state);
export const started: string | undefined = trigger.fire('binding.json').disposition?.requestId;
`
  );
  const program = ts.createProgram([script, declaration], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
  });
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  expect(diagnostics).toEqual([]);
});
