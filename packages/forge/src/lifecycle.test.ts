import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { discoverPlugins } from './discovery';
import { dispatchForge } from './dispatch';
import {
  contentDigest,
  forgeAuditResponse,
  mutationTarget,
  type ForgeRequest,
  type ForgeResponse,
} from './operations';

const fixture = join(import.meta.dir, 'fixtures', 'mutation-plugin.ts');
const ref = { repo: { host: 'forge.example', path: 'a/b' }, number: 42 };
const edit = {
  operationId: 'edit-1',
  op: 'pr.edit-body',
  ref,
  body: 'the authored body',
} satisfies ForgeRequest;
const create = {
  operationId: 'create-1',
  op: 'pr.create',
  repo: ref.repo,
  headRepo: ref.repo,
  head: 'feature',
  headRevision: 'headsha',
  base: 'dev',
  title: 'A title',
  body: 'A body',
  draft: true,
} satisfies ForgeRequest;
const ready = { operationId: 'ready-1', op: 'pr.ready', ref } satisfies ForgeRequest;
const marker = '<!-- archon-review-report -->';
const upsert = {
  operationId: 'comment-1',
  op: 'comment.upsert',
  ref,
  marker,
  body: `${marker}\nRound 1`,
} satisfies ForgeRequest;

async function dispatch(
  request: ForgeRequest,
  mode = 'ok',
  timeoutMs?: number
): Promise<Awaited<ReturnType<typeof dispatchForge>>> {
  const discovery = await discoverPlugins({
    config: {
      plugins: [{ plugin: 'mutator', command: process.execPath, args: [fixture, '--mode', mode] }],
      scanPath: false,
    },
    includeDefaultDir: false,
  });
  return dispatchForge(request, { discovery, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

describe('mutation evidence at the dispatch boundary', () => {
  test('accepts an applied result that answers the request', async () => {
    const result = await dispatch(edit);
    expect(result.response).toMatchObject({
      ok: true,
      result: {
        op: 'pr.edit-body',
        value: { outcome: 'applied', bodyDigest: contentDigest(edit.body) },
      },
    });
    expect(result.audit).toMatchObject({ operation: 'pr.edit-body', target: ref });
  });

  test.each([
    ['a different pull request', 'wrong-target'],
    ['a body it did not write', 'mismatch'],
  ])('refuses an applied result naming %s, without claiming a refusal', async (_label, mode) => {
    const result = await dispatch(edit, mode);
    expect(result.response).toMatchObject({
      ok: false,
      error: { kind: 'invalid_response' },
      // The plugin ran, so what it did to the pull request is not knowable here.
      mutation: { op: 'pr.edit-body', target: ref, outcome: 'outcome_unknown' },
    });
  });

  // Verification is not pr.edit-body's alone: a plugin's answer to a create, a
  // ready flip or a comment upsert is the only claim dispatch has that the write
  // did what it was asked, so each op's branch is exercised both ways.
  test.each([
    ['pr.create', create],
    ['pr.ready', ready],
    ['comment.upsert', upsert],
  ] as const)('accepts a %s result that answers the request', async (op, request) => {
    const result = await dispatch(request);
    expect(result.response).toMatchObject({
      ok: true,
      result: { op, value: { outcome: 'applied' } },
    });
  });

  test.each([
    ['pr.create', 'a revision it was not asked for', create],
    ['pr.ready', 'a pull request still in draft', ready],
    ['comment.upsert', 'a body it did not write', upsert],
  ] as const)('refuses a %s result naming %s', async (op, _label, request) => {
    const result = await dispatch(request, 'mismatch');
    expect(result.response).toMatchObject({
      ok: false,
      error: { kind: 'invalid_response' },
      mutation: { op, outcome: 'outcome_unknown' },
    });
  });

  test('accepts a result echoing the repository in the case the forge registered', async () => {
    const result = await dispatch(create, 'registered-case');
    expect(result.response).toMatchObject({
      ok: true,
      result: { op: 'pr.create', value: { outcome: 'applied' } },
    });
  });

  test('a failure with no mutation evidence is unknown, never a refusal', async () => {
    const result = await dispatch(edit, 'no-evidence');
    expect(result.response).toMatchObject({
      ok: false,
      error: { kind: 'invalid_response' },
      mutation: { op: 'pr.edit-body', outcome: 'outcome_unknown' },
    });
  });

  test("preserves the plugin's own refusal", async () => {
    const result = await dispatch(edit, 'refused');
    expect(result.response).toMatchObject({
      ok: false,
      error: { kind: 'conflict', message: 'the forge said no' },
      mutation: { op: 'pr.edit-body', target: ref, outcome: 'refused' },
    });
  });

  test('a plugin that never answers leaves the outcome unknown', async () => {
    const result = await dispatch(edit, 'hang', 200);
    expect(result.response).toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
      mutation: { op: 'pr.edit-body', outcome: 'outcome_unknown' },
    });
  });

  test('a mutation that never reached a plugin is refused, not unknown', async () => {
    // An empty discovery that never scans the developer's own plugin directory.
    const discovery = await discoverPlugins({
      config: { scanPath: false },
      includeDefaultDir: false,
    });
    const result = await dispatchForge(edit, { discovery });
    expect(result.response).toMatchObject({
      ok: false,
      error: { kind: 'no_plugin_for_host' },
      mutation: { op: 'pr.edit-body', target: ref, outcome: 'refused' },
    });
  });

  test('a read failure carries no mutation evidence at all', async () => {
    const result = await dispatchForge(
      { operationId: 'view-1', op: 'pr.view', selector: { kind: 'number', ref } },
      {
        discovery: await discoverPlugins({ config: { scanPath: false }, includeDefaultDir: false }),
      }
    );
    expect(result.response.ok).toBe(false);
    expect(result.response).not.toHaveProperty('mutation');
  });
});

test('mutationTarget names the repository for a create and the pull request otherwise', () => {
  expect(mutationTarget(edit)).toEqual(ref);
  expect(
    mutationTarget({
      operationId: 'create',
      op: 'pr.create',
      repo: ref.repo,
      headRepo: ref.repo,
      head: 'feature',
      headRevision: 'headsha',
      base: 'dev',
      title: 'A title',
      body: 'A body',
      draft: true,
    })
  ).toEqual(ref.repo);
});

test('the audit record keeps a digest of authored content, never the content', async () => {
  const result = await dispatch(
    { operationId: 'view-1', op: 'pr.view', selector: { kind: 'number', ref } },
    'view-content'
  );
  const serialized = JSON.stringify(result.audit);
  expect(serialized).not.toContain('A secret title');
  expect(serialized).not.toContain('A secret body');
  expect(result.audit.result).toMatchObject({
    ok: true,
    result: {
      op: 'pr.view',
      value: {
        content: {
          digest: contentDigest(JSON.stringify({ title: 'A secret title', body: 'A secret body' })),
          bytes: Buffer.byteLength(
            JSON.stringify({ title: 'A secret title', body: 'A secret body' })
          ),
        },
      },
    },
  });
});

test('a head selector accepts only an open pull request', async () => {
  const byHead = {
    operationId: 'head-1',
    op: 'pr.view',
    selector: { kind: 'head', repo: ref.repo, headRepo: ref.repo, head: 'feature' },
  } satisfies ForgeRequest;
  expect((await dispatch(byHead, 'view-content')).response).toMatchObject({ ok: true });
  // A branch closed long ago must not answer for the pull request this head has now.
  expect((await dispatch(byHead, 'closed')).response).toMatchObject({
    ok: false,
    error: { kind: 'invalid_response' },
  });
});

test('a pull request that a head selector did not find audits as an absence', () => {
  const response: ForgeResponse = {
    operationId: 'none',
    ok: true,
    result: { op: 'pr.view', value: null },
  };
  expect(forgeAuditResponse(response)).toEqual({
    operationId: 'none',
    ok: true,
    result: { op: 'pr.view', value: null },
  });
});
