import { expect, test } from 'bun:test';
import { matchesForgeOperationResponse } from './dispatch';
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
