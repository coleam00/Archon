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
const draft = { operationId: 'draft-1', op: 'pr.draft', ref } satisfies ForgeRequest;
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
  // ready/draft flip or a comment upsert is the only claim dispatch has that the write
  // did what it was asked, so each op's branch is exercised both ways.
  test.each([
    ['pr.create', create],
    ['pr.ready', ready],
    ['pr.draft', draft],
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
    ['pr.draft', 'a pull request still ready', draft],
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
        discovery: await discoverPlugins({ config: { scanPath: false } }),
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

const issueCreate = {
  operationId: 'issue',
  op: 'workitem.create',
  repo: ref.repo,
  title: 'secret title',
  body: `${marker}\nsecret body`,
  marker,
} satisfies ForgeRequest;
const labelsSet = {
  operationId: 'labels',
  op: 'workitem.labels.set',
  ref,
  labels: ['a', 'b'],
} satisfies ForgeRequest;
const labelEnsure = {
  operationId: 'ensure',
  op: 'repo.label.ensure',
  repo: ref.repo,
  name: 'name',
  color: 'abcdef',
  description: 'secret description',
} satisfies ForgeRequest;
const labelAdd = {
  operationId: 'label-add',
  op: 'workitem.label.add',
  subject: { kind: 'pr', ref },
  name: 'queued',
} satisfies ForgeRequest;
const labelRemove = {
  operationId: 'label-remove',
  op: 'workitem.label.remove',
  subject: { kind: 'issue', ref },
  name: 'queued',
} satisfies ForgeRequest;
const issueComment = {
  operationId: 'issue-comment',
  op: 'workitem.comment.upsert',
  subject: { kind: 'issue', ref },
  marker,
  body: `${marker}\nsecret body`,
} satisfies ForgeRequest;
const issueClose = {
  operationId: 'close',
  op: 'workitem.close',
  ref,
  reason: 'duplicate',
} satisfies ForgeRequest;
test.each([issueCreate, labelsSet, labelEnsure, labelAdd, labelRemove, issueComment, issueClose])(
  'new mutation dispatch verifies proof and preserves unknown failures: $op',
  async request => {
    const result = await dispatch(request);
    expect(result.response).toMatchObject({
      ok: true,
      result: { op: request.op, value: { outcome: 'applied' } },
    });
    expect(result.audit.target).toEqual(mutationTarget(request));
    for (const mode of ['mismatch', 'no-evidence'])
      expect((await dispatch(request, mode)).response).toMatchObject({
        ok: false,
        mutation: { outcome: 'outcome_unknown' },
      });
    expect((await dispatch(request, 'refused')).response).toMatchObject({
      ok: false,
      mutation: { outcome: 'refused' },
    });
    const audit = JSON.stringify(result.audit);
    for (const secret of ['secret title', 'secret body', 'secret description', marker])
      expect(audit).not.toContain(secret);
  }
);
test.each([labelAdd, labelRemove, issueComment])(
  'a subject result must name the requested item kind: $op',
  async request => {
    expect((await dispatch(request, 'wrong-kind')).response).toMatchObject({
      ok: false,
      mutation: { outcome: 'outcome_unknown', target: ref },
    });
  }
);

test('a label listing must answer with open items of the requested repository', async () => {
  const list = {
    operationId: 'list',
    op: 'workitem.list',
    repo: ref.repo,
    label: 'queued',
  } satisfies ForgeRequest;
  const result = await dispatch(list);
  expect(result.response).toMatchObject({
    ok: true,
    result: {
      op: 'workitem.list',
      value: { label: 'queued', items: [{ kind: 'issue' }, { kind: 'pr' }] },
    },
  });
  expect(result.audit.target).toEqual(ref.repo);
  expect(JSON.stringify(result.audit.result)).toBe(JSON.stringify(result.response));
  const closed = await dispatch(list, 'mismatch');
  expect(closed.response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
  expect(closed.response).not.toHaveProperty('mutation');
});

test('dispatch permits recovery of closed marked issues with edited content', async () => {
  expect((await dispatch(issueCreate, 'recovery')).response).toMatchObject({
    ok: true,
    result: { value: { changed: false, workitem: { state: 'closed' } } },
  });
});

const merge = {
  operationId: 'merge',
  op: 'pr.merge',
  ref,
  method: 'squash',
  conditions: { head: 'headsha' },
} satisfies ForgeRequest;
const rerun = {
  operationId: 'rerun',
  op: 'checks.rerun',
  ref,
  revision: 'headsha',
  units: [
    { unit: { kind: 'check', id: 'check-id', name: 'check' }, rerun: { id: 'run-id', attempt: 2 } },
  ],
} satisfies ForgeRequest;

test('merges and reruns require complete applied evidence at dispatch', async () => {
  for (const request of [merge, rerun]) {
    expect((await dispatch(request)).response.ok).toBe(true);
    expect((await dispatch(request, 'mismatch')).response).toMatchObject({
      ok: false,
      mutation: { outcome: 'outcome_unknown' },
    });
    const timeout = await dispatch(request, 'hang', 100);
    expect(timeout.response).toMatchObject({ ok: false, mutation: { outcome: 'outcome_unknown' } });
    if (!timeout.response.ok)
      expect(timeout.response.mutation).toMatchObject(
        request.op === 'pr.merge'
          ? { merge: { method: merge.method, conditions: merge.conditions } }
          : { rerun: { revision: rerun.revision, requested: rerun.units } }
      );
  }
});

test('unsupported or missing merge conditions do not launch the operation', async () => {
  const discovery = await discoverPlugins({
    config: {
      plugins: [{ plugin: 'mutator', command: process.execPath, args: [fixture] }],
      scanPath: false,
    },
  });
  // If dispatch launches this missing executable, the response is a process failure.
  for (const plugin of discovery.byHost.values()) plugin.command = '/missing-operation-executable';
  for (const conditions of [
    {},
    { head: 'headsha', base: 'base' },
    { head: 'headsha', tree: 'tree' },
  ]) {
    const result = await dispatchForge({ ...merge, conditions }, { discovery });
    expect(result.response).toMatchObject({
      ok: false,
      error: { kind: conditions.head ? 'unsupported_op' : 'invalid_request' },
      mutation: { outcome: 'refused' },
    });
  }
  expect((await dispatch(merge, 'no-conditions')).response).toMatchObject({
    ok: false,
    error: { kind: 'unsupported_op' },
    mutation: { outcome: 'refused' },
  });
});

test('review bodies reach callers and only their digests reach the audit', async () => {
  const result = await dispatch({ operationId: 'reviews', op: 'pr.reviews', ref });
  expect(JSON.stringify(result.response)).toContain('private review body');
  expect(JSON.stringify(result.audit)).not.toContain('private review body');
  expect(JSON.stringify(result.audit)).toContain(contentDigest('private review body'));
});

test.each(['wrong-method', 'wrong-condition', 'unenforced'])(
  'merge results cannot overstate enforcement or change the request: %s',
  async mode => {
    expect((await dispatch(merge, mode)).response).toMatchObject({
      ok: false,
      error: { kind: 'invalid_response' },
      mutation: { outcome: 'outcome_unknown' },
    });
  }
);

test('a partial rerun result cannot certify complete success', async () => {
  const request = {
    ...rerun,
    units: [
      ...rerun.units,
      { ...rerun.units[0], unit: { ...rerun.units[0].unit, id: 'another-check' } },
    ],
  };
  expect((await dispatch(request, 'subset')).response).toMatchObject({
    ok: false,
    error: { kind: 'invalid_response' },
    mutation: { outcome: 'outcome_unknown' },
  });
});

test('a plugin without draft conversion refuses without executing the operation', async () => {
  const discovery = await discoverPlugins({
    config: {
      plugins: [{ plugin: 'mutator', command: process.execPath, args: [fixture] }],
      scanPath: false,
    },
  });
  for (const plugin of discovery.byHost.values()) {
    plugin.metadata.capabilities = plugin.metadata.capabilities.filter(op => op !== 'pr.draft');
    plugin.command = '/missing-operation-executable';
  }
  expect((await dispatchForge(draft, { discovery })).response).toMatchObject({
    ok: false,
    error: { kind: 'unsupported_op' },
    mutation: { op: 'pr.draft', outcome: 'refused' },
  });
});

test('draft conversion accepts unchanged evidence and rejects a non-open read-back', async () => {
  expect((await dispatch(draft, 'unchanged')).response).toMatchObject({
    ok: true,
    result: { op: 'pr.draft', value: { changed: false, pr: { is_draft: true } } },
  });
  expect((await dispatch(draft, 'not-open')).response).toMatchObject({
    ok: false,
    error: { kind: 'invalid_response' },
    mutation: { outcome: 'outcome_unknown' },
  });
});

describe('review threads and issue bodies', () => {
  const reply = {
    operationId: 'reply-1',
    op: 'pr.thread.reply',
    ref,
    thread: 'thread-1',
    body: 'Fixed in abc123.',
  } satisfies ForgeRequest;
  const resolve = {
    operationId: 'resolve-1',
    op: 'pr.thread.resolve',
    ref,
    thread: 'thread-1',
  } satisfies ForgeRequest;
  const editIssue = {
    operationId: 'issue-body-1',
    op: 'workitem.edit-body',
    ref,
    body: 'The contract.\n\n## Current scope\n\nA ruling.',
  } satisfies ForgeRequest;

  test('thread comment bodies reach callers and only their digests reach the audit', async () => {
    const result = await dispatch({ operationId: 'threads', op: 'pr.threads', ref });
    expect(result.response).toMatchObject({
      ok: true,
      result: { op: 'pr.threads', value: { threads: [{ id: 'thread-1', resolved: false }] } },
    });
    expect(JSON.stringify(result.response)).toContain('private thread body');
    expect(JSON.stringify(result.audit)).not.toContain('private thread body');
    expect(JSON.stringify(result.audit)).toContain(contentDigest('private thread body'));
  });

  test.each([reply, resolve, editIssue])(
    'an applied $op that answers the request is accepted',
    async request => {
      expect((await dispatch(request)).response).toMatchObject({
        ok: true,
        result: { op: request.op, value: { outcome: 'applied' } },
      });
    }
  );

  test.each([reply, resolve, editIssue])(
    'an applied $op that does not answer the request becomes outcome_unknown',
    async request => {
      expect((await dispatch(request, 'mismatch')).response).toMatchObject({
        ok: false,
        mutation: { op: request.op, outcome: 'outcome_unknown' },
      });
    }
  );

  test('conversation comment bodies reach callers and only their digests reach the audit', async () => {
    const result = await dispatch({
      operationId: 'comments',
      op: 'workitem.comments',
      subject: { kind: 'pr', ref },
    });
    expect(result.response).toMatchObject({
      ok: true,
      result: {
        op: 'workitem.comments',
        value: { comments: [{ id: '7', author: { login: 'maintainer' } }] },
      },
    });
    expect(JSON.stringify(result.response)).toContain('private conversation comment');
    expect(JSON.stringify(result.audit)).not.toContain('private conversation comment');
    expect(JSON.stringify(result.audit)).toContain(contentDigest('private conversation comment'));
  });

  test.each([
    {
      operationId: 'checks-1',
      op: 'checks.commit',
      repo: ref.repo,
      at: { kind: 'revision', revision: 'asked' },
    },
    { operationId: 'merge-state-1', op: 'pr.merge-state', ref },
  ] satisfies ForgeRequest[])('a $op read that answers the request is accepted', async request => {
    expect((await dispatch(request)).response).toMatchObject({ ok: true });
  });

  test.each([
    {
      operationId: 'checks-1',
      op: 'checks.commit',
      repo: ref.repo,
      at: { kind: 'revision', revision: 'asked' },
    },
    { operationId: 'merge-state-1', op: 'pr.merge-state', ref },
  ] satisfies ForgeRequest[])(
    'a $op read about another commit or pull request is an invalid response',
    async request => {
      expect((await dispatch(request, 'mismatch')).response).toMatchObject({
        ok: false,
        error: { kind: 'invalid_response' },
      });
    }
  );
});
