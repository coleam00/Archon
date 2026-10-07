import { expect, test } from 'bun:test';
import { runForgeMutationConformance } from '@archon/forge/conformance';
import {
  forgeRequestSchema,
  mutationRequestSchema,
  type ForgeMutationRequest,
} from '@archon/forge/operations';
import { githubPluginMetadata, handleGithubOperation } from './operations';

const repo = { host: 'github.com', path: 'owner/repo' };
const ref = { repo, number: 1 };
const root = 'https://api.github.com/repos/owner/repo';
const marker = '<!-- canonical -->';
const create = forgeRequestSchema.parse({
  operationId: 'create',
  op: 'workitem.create',
  repo,
  title: 'Title',
  body: `${marker}\nBody`,
  marker,
});
function fixture(mode = 'ok') {
  const issue = {
    number: 1,
    repository_url: root,
    html_url: 'https://github.com/owner/repo/issues/1',
    title: 'Title',
    body: `${marker}\nBody`,
    state: 'open',
    labels: [{ name: 'other' }],
  };
  let issues: (typeof issue)[] = [];
  const labels = [{ name: 'other', color: 'abcdef', description: 'operator' }];
  const calls: string[] = [];
  let writes = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.origin + url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (method !== 'GET') {
      writes++;
      if (mode === 'refused') return Response.json({}, { status: 403 });
      if (mode === 'unknown') throw new Error('lost before response');
    }
    if (mode === 'lookup-failed' && method === 'GET') return Response.json({}, { status: 500 });
    if (path === `${root}/issues`) {
      if (method === 'POST') {
        const payload = JSON.parse(String(init?.body)) as { title: string; body: string };
        if (mode !== 'unverified') issues.push({ ...issue, ...payload });
        if (mode === 'lost-create') throw new Error('committed but response lost');
        return Response.json(issue, { status: 201 });
      }
      const page = Number(url.searchParams.get('page'));
      return Response.json(page === 1 ? issues : []);
    }
    if (path === `${root}/issues/1`) {
      if (mode === 'read-failed' && writes > 0) return Response.json({}, { status: 500 });
      return issues[0] ? Response.json(issues[0]) : Response.json({}, { status: 404 });
    }
    if (path === `${root}/issues/1/labels`) {
      if (mode !== 'unverified')
        issue.labels = (JSON.parse(String(init?.body)) as { labels: string[] }).labels.map(
          name => ({ name })
        );
      return Response.json(issue.labels);
    }
    if (path === `${root}/labels`) {
      if (method === 'POST' && mode !== 'unverified')
        labels.push(JSON.parse(String(init?.body)) as (typeof labels)[number]);
      return Response.json(labels);
    }
    if (path.startsWith(`${root}/labels/`)) {
      const label = labels.find(
        row => row.name === decodeURIComponent(url.pathname.split('/').pop() ?? '')
      );
      return label ? Response.json(label) : Response.json({}, { status: 404 });
    }
    throw new Error(`unexpected ${path}`);
  };
  return {
    issue,
    labels,
    calls,
    fetch,
    seed: (rows = [issue]) => {
      issues = rows;
    },
    writes: () => writes,
  };
}
const run = (
  request: Parameters<typeof handleGithubOperation>[0],
  fake: ReturnType<typeof fixture>
) => handleGithubOperation(request, { token: 'secret', fetch: fake.fetch });

test('lost create response recovers the existing issue without a second mutation', async () => {
  const fake = fixture('lost-create');
  expect(await run(create, fake)).toMatchObject({
    ok: false,
    mutation: { outcome: 'outcome_unknown' },
  });
  expect(await run(create, fake)).toMatchObject({
    ok: true,
    result: { value: { changed: false, workitem: { ref } } },
  });
  expect(fake.writes()).toBe(1);
  expect(fake.calls.at(-1)).toBe(`GET ${root}/issues/1`);
});

test('closed recovery preserves edited content, ambiguous and failed lookups never create', async () => {
  const fake = fixture();
  fake.seed([{ ...fake.issue, state: 'closed', title: 'Edited', body: `${marker}\nEdited` }]);
  expect(await run(create, fake)).toMatchObject({
    ok: true,
    result: { value: { changed: false, workitem: { state: 'closed' } } },
  });
  fake.seed([fake.issue, { ...fake.issue, number: 2 }]);
  expect(await run(create, fake)).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
  expect(fake.writes()).toBe(0);
  const failed = fixture('lookup-failed');
  expect(await run(create, failed)).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
  expect(failed.writes()).toBe(0);
});

test('marker lookup includes later pages and excludes PRs', async () => {
  const fake = fixture();
  const page = Array.from({ length: 100 }, (_, index) => ({
    ...fake.issue,
    number: index + 2,
    body: 'unmarked',
  }));
  const baseFetch = fake.fetch;
  fake.seed();
  fake.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/issues') && (init?.method ?? 'GET') === 'GET')
      return Response.json(
        url.searchParams.get('page') === '1'
          ? [...page.slice(1), { ...fake.issue, pull_request: {} }]
          : [fake.issue]
      );
    return baseFetch(input, init);
  };
  expect(await run(create, fake)).toMatchObject({
    ok: true,
    result: { value: { changed: false } },
  });
  expect(fake.writes()).toBe(0);
});

test('label set clears, verifies exact sets, no-ops, and never creates missing names', async () => {
  const fake = fixture();
  fake.seed();
  const set = {
    operationId: 'labels',
    op: 'workitem.labels.set',
    ref,
    labels: ['other'],
  } satisfies ForgeMutationRequest;
  expect(await run(set, fake)).toMatchObject({ ok: true, result: { value: { changed: false } } });
  expect(await run({ ...set, labels: ['missing'] }, fake)).toMatchObject({
    ok: false,
    mutation: { outcome: 'refused' },
  });
  expect(fake.writes()).toBe(0);
  expect(await run({ ...set, labels: [] }, fake)).toMatchObject({
    ok: true,
    result: { value: { changed: true, labels: [] } },
  });
  expect(fake.writes()).toBe(1);
  expect(fake.calls.at(-1)).toBe(`GET ${root}/issues/1`);
});

test('explicit ensure preserves existing metadata and independently verifies creation', async () => {
  const fake = fixture();
  const ensure = {
    operationId: 'ensure',
    op: 'repo.label.ensure',
    repo,
    name: 'other',
    color: '123456',
    description: 'replacement',
  } satisfies ForgeMutationRequest;
  expect(await run(ensure, fake)).toMatchObject({
    ok: true,
    result: { value: { changed: false, label: { color: 'abcdef' } } },
  });
  expect(await run({ ...ensure, name: 'new' }, fake)).toMatchObject({
    ok: true,
    result: { value: { changed: true } },
  });
  expect(fake.writes()).toBe(1);
  expect(fake.calls.at(-1)).toBe(`GET ${root}/labels/new`);
});

test('each new mutation passes conformance for all four outcomes', async () => {
  for (const op of ['workitem.create', 'workitem.labels.set', 'repo.label.ensure'] as const) {
    const request = mutationRequestSchema.parse(
      op === 'workitem.create'
        ? create
        : op === 'workitem.labels.set'
          ? { operationId: op, op, ref, labels: [] }
          : { operationId: op, op, repo, name: 'new', color: 'abcdef', description: 'Description' }
    );
    const modes = [
      ['ok', 'applied'],
      ['refused', 'refused'],
      ['unknown', 'outcome_unknown'],
      ['unverified', 'verification_failed'],
    ] as const;
    for (const [mode, expectedOutcome] of modes) {
      const fake = fixture(mode);
      if (op === 'workitem.labels.set') fake.seed();
      expect(
        await runForgeMutationConformance(req => run(req, fake), githubPluginMetadata, [
          { name: `${op}:${mode}`, request, expectedOutcome },
        ])
      ).toEqual([]);
      expect(fake.writes()).toBe(1);
    }
  }
});

test('acknowledged create with failed read-back is a verification failure', async () => {
  const fake = fixture('read-failed');
  expect(await run(create, fake)).toMatchObject({
    ok: false,
    mutation: { outcome: 'verification_failed' },
  });
  expect(fake.writes()).toBe(1);
});

test('wrong issue identity is refused before label mutation', async () => {
  const fake = fixture();
  fake.seed([{ ...fake.issue, number: 9 }]);
  expect(
    await run({ operationId: 'labels', op: 'workitem.labels.set', ref, labels: [] }, fake)
  ).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
  expect(fake.writes()).toBe(0);
});

test('fresh read-back must prove content and repository identity, not just a successful POST', async () => {
  for (const patch of [
    { title: 'wrong' },
    { body: 'unmarked' },
    { repository_url: 'https://api.github.com/repos/other/repo' },
    { number: 9 },
  ]) {
    const fake = fixture();
    const baseFetch = fake.fetch;
    fake.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (String(input) === `${root}/issues/1`) return Response.json({ ...fake.issue, ...patch });
      return response;
    };
    expect(await run(create, fake)).toMatchObject({
      ok: false,
      mutation: { outcome: 'verification_failed' },
    });
    expect(fake.writes()).toBe(1);
  }
});
