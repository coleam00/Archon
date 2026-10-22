import { expect, test } from 'bun:test';
import { matchesForgeOperationResponse } from './response-match';
import {
  contentDigest,
  forgeAuditResponse,
  forgeRequestSchema,
  forgeResponseSchema,
  type ForgeRequest,
  type ForgeResponse,
} from './operations';
const repo = { host: 'forge.example', path: 'group/team/repo' };
const ref = { repo, number: 3 };
const marker = '<!-- marker -->';
const create = {
  operationId: 'create',
  op: 'workitem.create',
  repo,
  title: 'secret title',
  body: `${marker}\nsecret body`,
  marker,
} satisfies ForgeRequest;
const metadata = {
  protocol: 1,
  name: 'test',
  version: '1',
  forge: 'test',
  hosts: [repo.host],
  capabilities: [],
  token_env: [],
} as const;
const plugin = { ...metadata, hosts: [...metadata.hosts], capabilities: [], token_env: [] };
const item = {
  ref,
  kind: 'issue',
  url: 'https://forge.example/group/team/repo/issues/3',
  state: 'open',
} as const;
const response = (op: string, target: unknown, facts: object, changed = true): ForgeResponse =>
  forgeResponseSchema.parse({
    operationId: 'create',
    ok: true,
    result: { op, value: { target, outcome: 'applied', changed, ...facts } },
  });
const matches = (request: ForgeRequest, result: ForgeResponse): boolean =>
  matchesForgeOperationResponse(request, result, plugin, repo.host);
const facts = {
  workitem: item,
  markerDigest: contentDigest(marker),
  titleDigest: contentDigest(create.title),
  bodyDigest: contentDigest(create.body),
};

test('create proof distinguishes fresh content from recovery without exposing authored content', () => {
  const result = response(create.op, repo, facts);
  expect(matches(create, result)).toBe(true);
  for (const changed of [
    { titleDigest: 'wrong' },
    { bodyDigest: 'wrong' },
    { markerDigest: 'wrong' },
    { workitem: { ...item, ref: { ...ref, repo: { ...repo, path: 'other/repo' } } } },
    { workitem: { ...item, state: 'closed' } },
  ]) {
    expect(matches(create, response(create.op, repo, { ...facts, ...changed }))).toBe(false);
  }
  expect(
    matches(
      create,
      response(
        create.op,
        repo,
        {
          ...facts,
          titleDigest: 'edited',
          bodyDigest: 'edited',
          workitem: { ...item, state: 'closed' },
        },
        false
      )
    )
  ).toBe(true);
  expect(
    matches(create, response(create.op, repo, { ...facts, markerDigest: 'wrong' }, false))
  ).toBe(false);
  const audit = JSON.stringify(forgeAuditResponse(result));
  expect(audit).not.toContain(create.title);
  expect(audit).not.toContain(create.body);
  expect(audit).not.toContain(marker);
});

test('label proof verifies exact set, target and issue kind', () => {
  const request = {
    operationId: 'labels',
    op: 'workitem.labels.set',
    ref,
    labels: ['a', 'b'],
  } satisfies ForgeRequest;
  expect(matches(request, response(request.op, ref, { workitem: item, labels: ['b', 'a'] }))).toBe(
    true
  );
  for (const labels of [[], ['a'], ['a', 'b', 'other']])
    expect(matches(request, response(request.op, ref, { workitem: item, labels }))).toBe(false);
  expect(
    matches(
      request,
      response(request.op, ref, {
        workitem: { ...item, ref: { ...ref, number: 4 } },
        labels: request.labels,
      })
    )
  ).toBe(false);
  expect(() =>
    response(request.op, ref, { workitem: { ...item, kind: 'pr' }, labels: request.labels })
  ).toThrow();
});

test('label ensure proof permits existing metadata but verifies newly authored metadata', () => {
  const request = forgeRequestSchema.parse({
    operationId: 'label',
    op: 'repo.label.ensure',
    repo,
    name: 'name',
    color: 'ABCDEF',
    description: 'secret description',
  });
  if (request.op !== 'repo.label.ensure') throw new Error('expected ensure');
  expect(request.color).toBe('abcdef');
  const label = {
    name: request.name,
    color: request.color,
    descriptionDigest: contentDigest(request.description),
  };
  expect(matches(request, response(request.op, repo, { label }))).toBe(true);
  expect(
    matches(
      request,
      response(request.op, repo, { label: { ...label, descriptionDigest: 'different' } })
    )
  ).toBe(false);
  expect(
    matches(
      request,
      response(request.op, repo, { label: { ...label, descriptionDigest: 'different' } }, false)
    )
  ).toBe(true);
  expect(
    matches(request, response(request.op, repo, { label: { ...label, name: 'other' } }, false))
  ).toBe(false);
  expect(JSON.stringify(forgeAuditResponse(response(request.op, repo, { label })))).not.toContain(
    request.description
  );
});

test('new failure observations cannot claim an unrelated target', () => {
  const failed = forgeResponseSchema.parse({
    operationId: create.operationId,
    ok: false,
    error: { kind: 'conflict', message: 'no' },
    mutation: {
      op: create.op,
      target: repo,
      outcome: 'refused',
      workitem: { ...item, ref: { ...ref, repo: { ...repo, path: 'wrong' } } },
    },
  });
  expect(matches(create, failed)).toBe(false);
  expect(
    matches(create, {
      operationId: create.operationId,
      ok: false,
      error: { kind: 'conflict', message: 'no' },
    })
  ).toBe(false);
});

test('request schemas enforce canonical marker and unique labels, old item views retain compatibility', () => {
  expect(forgeRequestSchema.safeParse(create).success).toBe(true);
  for (const marker of ['', 'different', 'two\nlines'])
    expect(forgeRequestSchema.safeParse({ ...create, marker }).success).toBe(false);
  expect(
    forgeRequestSchema.safeParse({
      operationId: 'labels',
      op: 'workitem.labels.set',
      ref,
      labels: ['same', 'same'],
    }).success
  ).toBe(false);
  expect(
    forgeRequestSchema.safeParse({
      operationId: 'labels',
      op: 'workitem.labels.set',
      ref,
      labels: [''],
    }).success
  ).toBe(false);
  expect(
    forgeResponseSchema.safeParse({
      operationId: 'view',
      ok: true,
      result: { op: 'workitem.view', value: { ...item, title: '', body: '' } },
    }).success
  ).toBe(true);
});

test('repository list responses must echo the requested repository', () => {
  const request = { operationId: 'list', op: 'repo.labels.list', repo } satisfies ForgeRequest;
  const result: ForgeResponse = {
    operationId: 'list',
    ok: true,
    result: { op: request.op, value: { repo, labels: [{ name: 'label' }] } },
  };
  expect(matches(request, result)).toBe(true);
  expect(
    matches(request, {
      ...result,
      result: { op: request.op, value: { repo: { ...repo, path: 'wrong' }, labels: [] } },
    })
  ).toBe(false);
});

test('single-label proof verifies subject kind, identity and the one label', () => {
  const pr = { ...item, kind: 'pr' } as const;
  const add = {
    operationId: 'add',
    op: 'workitem.label.add',
    subject: { kind: 'pr', ref },
    name: 'queued',
  } satisfies ForgeRequest;
  const remove = { ...add, operationId: 'remove', op: 'workitem.label.remove' } as const;
  expect(matches(add, response(add.op, ref, { workitem: pr, labels: ['other', 'queued'] }))).toBe(
    true
  );
  expect(matches(add, response(add.op, ref, { workitem: pr, labels: ['other'] }))).toBe(false);
  expect(matches(add, response(add.op, ref, { workitem: item, labels: ['queued'] }))).toBe(false);
  expect(
    matches(
      add,
      response(add.op, ref, { workitem: { ...pr, ref: { ...ref, number: 4 } }, labels: ['queued'] })
    )
  ).toBe(false);
  expect(matches(remove, response(remove.op, ref, { workitem: pr, labels: ['other'] }))).toBe(true);
  expect(matches(remove, response(remove.op, ref, { workitem: pr, labels: ['queued'] }))).toBe(
    false
  );
});

test('failure evidence must name the requested item kind', () => {
  const failed = (op: string, workitem: object): ForgeResponse =>
    forgeResponseSchema.parse({
      operationId: 'failed',
      ok: false,
      error: { kind: 'invalid_response', message: 'no' },
      mutation: { op, target: ref, outcome: 'verification_failed', leaveBehind: 'x', workitem },
    });
  const add = {
    operationId: 'failed',
    op: 'workitem.label.add',
    subject: { kind: 'pr', ref },
    name: 'queued',
  } satisfies ForgeRequest;
  const set = {
    operationId: 'failed',
    op: 'workitem.labels.set',
    ref,
    labels: [],
  } satisfies ForgeRequest;
  expect(matches(add, failed(add.op, { ...item, kind: 'pr' }))).toBe(true);
  expect(matches(add, failed(add.op, item))).toBe(false);
  expect(matches(set, failed(set.op, item))).toBe(true);
  expect(matches(set, failed(set.op, { ...item, kind: 'pr' }))).toBe(false);
});

test('a label listing proves its repository, label and open state', () => {
  const request = {
    operationId: 'list',
    op: 'workitem.list',
    repo,
    label: 'queued',
  } satisfies ForgeRequest;
  const listed = (value: object): ForgeResponse =>
    forgeResponseSchema.parse({
      operationId: 'list',
      ok: true,
      result: { op: request.op, value: { repo, label: request.label, items: [item], ...value } },
    });
  expect(matches(request, listed({}))).toBe(true);
  expect(matches(request, listed({ items: [] }))).toBe(true);
  for (const wrong of [
    { label: 'other' },
    { repo: { ...repo, path: 'other/repo' } },
    { items: [{ ...item, state: 'closed' }] },
    { items: [{ ...item, ref: { ...ref, repo: { ...repo, path: 'other/repo' } } }] },
  ])
    expect(matches(request, listed(wrong))).toBe(false);
});

test('item and pull request views accept an author and still parse without one', () => {
  const author = { host: repo.host, id: '1', login: 'octo' };
  const pr = {
    schemaVersion: 1,
    ...ref,
    url: 'https://forge.example/group/team/repo/pull/3',
    head: 'feature',
    base: 'dev',
    is_draft: false,
    state: 'open',
    head_repo: repo,
    head_revision: 'head',
    base_revision: 'base',
    maintainer_can_modify: null,
  };
  for (const extra of [{}, { author }, { author: null }]) {
    expect(
      forgeResponseSchema.safeParse({
        operationId: 'view',
        ok: true,
        result: { op: 'workitem.view', value: { ...item, title: '', body: '', ...extra } },
      }).success
    ).toBe(true);
    expect(
      forgeResponseSchema.safeParse({
        operationId: 'view',
        ok: true,
        result: { op: 'pr.view', value: { pr, title: '', body: '', ...extra } },
      }).success
    ).toBe(true);
  }
});

test('close proof verifies the issue, its closed state and the requested reason', () => {
  const close = {
    operationId: 'close',
    op: 'workitem.close',
    ref,
    reason: 'duplicate',
  } satisfies ForgeRequest;
  const closed = { ...item, state: 'closed' } as const;
  expect(matches(close, response(close.op, ref, { workitem: closed, reason: 'duplicate' }))).toBe(
    true
  );
  for (const wrong of [
    { workitem: item, reason: 'duplicate' },
    { workitem: closed, reason: 'completed' },
    { workitem: { ...closed, ref: { ...ref, number: 4 } }, reason: 'duplicate' },
  ])
    expect(matches(close, response(close.op, ref, wrong))).toBe(false);
});
