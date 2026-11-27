// @archon-test-isolated
/**
 * The `archon:script` module over a stand-in host CLI: what it sends, how it reads the
 * host's answers and exit codes, and that its declaration type-checks a script that has
 * nothing but the declaration file.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  ForgeError,
  forge,
  HostCommandError,
  ItemWriteError,
  item,
  items,
  linkItem,
  notice,
  recordLanding,
  recordMerge,
  state,
  trigger,
} from './module';
import { scriptApiDeclaration } from './text';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'archon-script-api-')));
const previous = process.env.ARCHON_CLI_COMMAND;
const previousRun = process.env.WORKFLOW_ID;

beforeAll(() => {
  const host = join(root, 'host.ts');
  // Stands in for `archon`: answers each command from the arguments and input it was handed.
  writeFileSync(
    host,
    `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const [command, sub] = args;
const answer = (value: unknown, code = 0): void => {
  process.stdout.write(JSON.stringify(value));
  process.exitCode = code;
};
if (command === 'forge') {
  const request = JSON.parse(readFileSync(args.at(-1)!, 'utf8'));
  if (request.silent) process.exitCode = 1;
  else {
    if (request.reason) process.stderr.write(request.reason);
    const itemRecord = request.unrecorded ? { itemRecord: { recorded: false, reason: 'no_merge_time' } } : {};
    if (request.fail)
      answer({ operationId: 'x', ok: false, error: { kind: 'conflict', message: 'head moved' },
        mutation: { op: sub, target: request.ref, outcome: 'refused' }, ...itemRecord }, request.exit ?? 1);
    else answer({ operationId: 'x', ok: true, result: { op: sub, value: { echoed: request } }, ...itemRecord }, request.exit ?? 0);
  }
} else if (command === 'state' && args.includes('--held')) {
  answer({ ok: false, error: 'not held', code: 3, reason: 'lease_not_held' }, 3);
} else if (command === 'state' && sub === 'claim') {
  answer({ claimed: null, skipped: [{ name: 'a', reason: 'missing' }] }, 2);
} else if (command === 'state') {
  answer({ name: args[2], revision: 4, args: args.slice(3), stdin: await Bun.stdin.text() });
} else if (command === 'workflow' && sub === 'notice') {
  const text = args.at(-1)!;
  if (text === 'too many') answer({ ok: false, action: 'notice', error: 'limit reached', reason: 'run_limit' }, 1);
  else writeFileSync(${JSON.stringify(join(root, 'notice.json'))}, JSON.stringify(args.slice(2)));
} else if (command === 'workflow' && sub === 'runs') {
  const runId = args[args.indexOf('--item-of') + 1];
  if (runId === 'on-item') answer({ item: { key: 'issue-7' }, answers: [{ kind: 'ruling' }] });
  else if (runId === 'no-item') answer({ ok: false, error: 'not_found', run: runId }, 1);
  else answer({ ok: false, error: 'database locked' }, 1);
} else if (command === 'workflow' && sub === 'items') {
  if (args.includes('broken')) answer({ ok: false, error: 'after is not a cursor this read returned' }, 1);
  else answer({ window: { since: 'a', until: 'b' }, items: [], next: null, args: args.slice(2) });
} else if (command === 'workflow' && ['link', 'merged', 'landing'].includes(sub)) {
  writeFileSync(${JSON.stringify(join(root, 'write.json'))}, JSON.stringify(args.slice(1)));
  if (args.includes('missing')) answer({ ok: false, error: 'not_found' }, 1);
  else answer({ answered: sub });
} else if (command === 'trigger') {
  const inputs = readFileSync(args[args.indexOf('--inputs') + 1]!, 'utf8');
  writeFileSync(${JSON.stringify(join(root, 'trigger.json'))}, JSON.stringify(args.slice(2, -2)));
  answer({ id: 'receipt-1', bindings: [{ disposition: { status: 'admitted', requestId: 'q', runId: inputs } }] });
}
`
  );
  process.env.ARCHON_CLI_COMMAND = JSON.stringify([process.execPath, '--no-env-file', host]);
});

afterAll(async () => {
  await removeTempTree(root);
  if (previous === undefined) delete process.env.ARCHON_CLI_COMMAND;
  else process.env.ARCHON_CLI_COMMAND = previous;
  if (previousRun === undefined) delete process.env.WORKFLOW_ID;
  else process.env.WORKFLOW_ID = previousRun;
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

test('forge returns the result, and a completed operation the host could not record', () => {
  expect(forge('pr.ready', { ref })).toEqual({ echoed: { ref } } as never);
  const stderr = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const reason = 'merged it but the item record could not be written: store unavailable';
    expect(forge('pr.ready', { ref, exit: 2, reason } as never)).toEqual({
      echoed: { ref, exit: 2, reason },
    } as never);
    // The host's own reason reaches the script, not a generic warning in its place.
    expect(stderr.mock.calls).toEqual([[reason]]);
    stderr.mockClear();
    // A merge that succeeded but was not recorded on the item is no failure, and is said.
    const unrecorded = 'merged it, but the forge plugin reported no merge time';
    expect(forge('pr.merge', { ref, unrecorded: true, reason: unrecorded } as never)).toEqual({
      echoed: { ref, unrecorded: true, reason: unrecorded },
    } as never);
    expect(stderr.mock.calls).toEqual([[unrecorded]]);
  } finally {
    stderr.mockRestore();
  }
});

test('a refusal the host could not record on the item passes the host reason on before it throws', () => {
  const stderr = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    for (const request of [
      { ref, fail: true, exit: 2, reason: 'found it already merged, but the store failed' },
      { ref, fail: true, unrecorded: true, reason: 'the forge plugin reported no merge time' },
    ]) {
      stderr.mockClear();
      expect(thrownBy(() => forge('pr.merge', request as never))).toBeInstanceOf(ForgeError);
      expect(stderr.mock.calls).toEqual([[request.reason]]);
    }
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

test('trigger.fire names the item, declines one, or leaves the host to inherit it', () => {
  const sent = (options: Parameters<typeof trigger.fire>[2]): unknown => {
    trigger.fire('/bindings/next.json', {}, options);
    return JSON.parse(readFileSync(join(root, 'trigger.json'), 'utf8'));
  };
  const binding = ['--binding', '/bindings/next.json'];
  expect(sent({ item: 'item-2' })).toEqual([...binding, '--item', 'item-2']);
  expect(sent({ item: null })).toEqual([...binding, '--no-item']);
  expect(sent({})).toEqual(binding);
});

test('trigger.fire passes the config layer and the model rebindings it was given', () => {
  const sent = (options: Parameters<typeof trigger.fire>[2]): unknown => {
    trigger.fire('/bindings/next.json', {}, options);
    return JSON.parse(readFileSync(join(root, 'trigger.json'), 'utf8'));
  };
  // The binding file, then the two choices for these starts, in the order a reader expects.
  expect(sent({ config: '/cfg/one-off.yaml', model: ['large=pi/x', '@reviewer=pi/y'] })).toEqual([
    '--binding',
    '/bindings/next.json',
    '--config',
    '/cfg/one-off.yaml',
    '--model',
    'large=pi/x',
    '--model',
    '@reviewer=pi/y',
  ]);
  expect(sent({ model: [] })).toEqual(['--binding', '/bindings/next.json']);
});

test('notice sends its text after the labels, and a refusal is the host error', () => {
  notice('-merged pull request 7', { kind: 'merged', pr: '7' });
  expect(JSON.parse(readFileSync(join(root, 'notice.json'), 'utf8'))).toEqual([
    '--json',
    '--label',
    'kind=merged',
    '--label',
    'pr=7',
    '--',
    '-merged pull request 7',
  ]);
  const refused = thrownBy(() => notice('too many'));
  expect(refused).toBeInstanceOf(HostCommandError);
  expect(refused).toMatchObject({ command: 'workflow notice', exitCode: 1 });
  expect((refused as Error).message).toContain('limit reached');
});

test("item reads this run's item, null when the run is on none, and a host failure throws", () => {
  process.env.WORKFLOW_ID = 'on-item';
  expect(item()).toEqual({ item: { key: 'issue-7' }, answers: [{ kind: 'ruling' }] } as never);
  process.env.WORKFLOW_ID = 'no-item';
  expect(item()).toBeNull();
  process.env.WORKFLOW_ID = 'broken';
  const failure = thrownBy(() => item());
  expect(failure).toBeInstanceOf(HostCommandError);
  expect((failure as Error).message).toContain('database locked');
});

test('item writes name the run, not an item, and return what the host printed', () => {
  process.env.WORKFLOW_ID = 'on-item';
  const sent = (write: () => unknown): unknown[] => {
    expect(write()).toEqual({ answered: expect.any(String) });
    return JSON.parse(readFileSync(join(root, 'write.json'), 'utf8'));
  };
  const own = ['--item-of', 'on-item'];
  expect(sent(() => linkItem({ kind: 'part_of', to: 'parent' }))).toEqual([
    'link',
    ...own,
    '--kind',
    'part_of',
    '--to',
    'parent',
    '--json',
  ]);
  expect(sent(() => linkItem({ kind: 'part_of', from: 'child' }))).toEqual([
    'link',
    ...own,
    '--kind',
    'part_of',
    '--from',
    'child',
    '--json',
  ]);
  const at = '2026-11-21T10:00:00Z';
  const commit = 'a'.repeat(40);
  expect(sent(() => recordMerge({ change: 'https://forge/pr/7', at, commit }))).toEqual([
    'merged',
    ...own,
    '--change',
    'https://forge/pr/7',
    '--at',
    at,
    '--commit',
    commit,
    '--json',
  ]);
  expect(sent(() => recordLanding('feature/x'))).toEqual([
    'landing',
    ...own,
    '--branch',
    'feature/x',
    '--json',
  ]);
});

test("a refused item write is the typed error with the host's reason", () => {
  process.env.WORKFLOW_ID = 'on-item';
  const refused = thrownBy(() => linkItem({ kind: 'depends_on', to: 'missing' }));
  expect(refused).toBeInstanceOf(ItemWriteError);
  expect(refused).toBeInstanceOf(HostCommandError);
  expect(refused).toMatchObject({ command: 'workflow link', exitCode: 1, reason: 'not_found' });
});

test('items hands its query to the host command and returns the page it printed', () => {
  expect(items({ since: '7d', limit: 50 })).toEqual({
    window: { since: 'a', until: 'b' },
    items: [],
    next: null,
    args: ['--json', '--since', '7d', '--limit', '50'],
  } as never);
  expect((items({ after: 'cursor' }) as unknown as { args: string[] }).args).toEqual([
    '--json',
    '--after',
    'cursor',
  ]);
  const failure = thrownBy(() => items({ after: 'broken' }));
  expect(failure).toBeInstanceOf(HostCommandError);
  expect((failure as Error).message).toContain('not a cursor');
});

test('the declaration alone type-checks a script against the forge and state contracts', () => {
  const declaration = join(root, 'archon-script.d.ts');
  const script = join(root, 'script.ts');
  writeFileSync(declaration, scriptApiDeclaration);
  writeFileSync(
    script,
    `import { ForgeError, ItemWriteError, forge, input, item, linkItem, outcomes, recordLanding, recordMerge, state, trigger } from 'archon:script';
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
export const conflict: 'revision_moved' | 'lease_held' | 'lease_not_held' | number = written.ok
  ? written.revision.revision
  : written.conflict;
// @ts-expect-error a put names the revision it replaces
state.put('queue/a', {});
export const states: string[] = outcomes().nodes.map(node => node.state);
export const started: string | undefined = trigger.fire('binding.json').disposition?.requestId;
export const created: boolean = linkItem({ kind: 'part_of', to: 'parent' }).created;
// @ts-expect-error a link names one other end, not both
linkItem({ kind: 'part_of', to: 'a', from: 'b' });
export const first: string = recordMerge({ change: 'pr', at: 'now' }).merge.change;
export const lands: string = recordLanding('feature/x').branch;
export function refusal(error: unknown): string | undefined {
  return error instanceof ItemWriteError ? error.reason : undefined;
}
export const rulings: string[] = (item()?.answers ?? []).flatMap(answer =>
  answer.kind === 'ruling' && answer.withdrawn === null ? [answer.text] : []
);
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
