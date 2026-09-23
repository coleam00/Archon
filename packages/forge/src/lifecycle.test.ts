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
    ['a body it did not write', 'wrong-digest'],
  ])('refuses an applied result naming %s, without claiming a refusal', async (_label, mode) => {
    const result = await dispatch(edit, mode);
    expect(result.response).toMatchObject({
      ok: false,
      error: { kind: 'invalid_response' },
      // The plugin ran, so what it did to the pull request is not knowable here.
      mutation: { op: 'pr.edit-body', target: ref, outcome: 'outcome_unknown' },
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
    const result = await dispatchForge(edit, {
      config: { plugins: [], scanPath: false },
      discovery: undefined,
    });
    expect(result.response).toMatchObject({
      ok: false,
      error: { kind: 'no_plugin_for_host' },
      mutation: { op: 'pr.edit-body', target: ref, outcome: 'refused' },
    });
  });

  test('a read failure carries no mutation evidence at all', async () => {
    const result = await dispatchForge(
      { operationId: 'view-1', op: 'pr.view', selector: { kind: 'number', ref } },
      { config: { plugins: [], scanPath: false } }
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
