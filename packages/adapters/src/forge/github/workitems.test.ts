import { expect, test } from 'bun:test';
import { runForgeMutationConformance } from '@archon/forge/conformance';
import {
  forgeRequestSchema,
  mutationRequestSchema,
  type ForgeMutationRequest,
} from '@archon/forge/operations';
import type { Fetch } from './api';
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

/**
 * One GitHub item whose label writes behave like GitHub's: PUT replaces the set,
 * POST adds names, DELETE removes one. With `interleave`, every label write waits
 * until two operations have read the item, so both act on the same stale read.
 */
function labelForge(options: { kind?: 'issue' | 'pr'; interleave?: boolean; lose?: boolean } = {}) {
  const item = {
    number: 1,
    repository_url: root,
    html_url: 'https://github.com/owner/repo/issues/1',
    title: 'Title',
    body: 'Body',
    state: 'open',
    labels: [{ name: 'other' }],
    user: { id: 42, login: 'octo' },
    ...(options.kind === 'pr' ? { pull_request: {} } : {}),
  };
  const repoLabels = ['other', 'a', 'b', 'queued'].map(name => ({
    name,
    color: 'abcdef',
    description: null,
  }));
  const calls: string[] = [];
  let reads = 0;
  const bothRead = Promise.withResolvers<void>();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.origin + url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (path === `${root}/issues/1` && method === 'GET') {
      if (++reads === 2) bothRead.resolve();
      return Response.json(structuredClone(item));
    }
    if (path === `${root}/labels`) return Response.json(repoLabels);
    if (path.startsWith(`${root}/labels/`)) {
      const name = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      const label = repoLabels.find(row => row.name.toLowerCase() === name.toLowerCase());
      return label ? Response.json(label) : Response.json({}, { status: 404 });
    }
    if (path.startsWith(`${root}/issues/1/labels`)) {
      if (options.interleave) await bothRead.promise;
      if (method === 'PUT' && !options.lose) {
        const names = (JSON.parse(String(init?.body)) as { labels: string[] }).labels;
        item.labels = names.map(name => ({ name }));
      }
      if (method === 'POST' && !options.lose) {
        for (const name of (JSON.parse(String(init?.body)) as { labels: string[] }).labels)
          if (!item.labels.some(label => label.name === name)) item.labels.push({ name });
      }
      if (method === 'DELETE') {
        const name = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        if (!item.labels.some(label => label.name === name))
          return Response.json({ message: 'Label does not exist' }, { status: 404 });
        if (!options.lose) item.labels = item.labels.filter(label => label.name !== name);
      }
      return Response.json(item.labels);
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const labels = (): string[] => item.labels.map(label => label.name).sort();
  const writes = (): number => calls.filter(call => !call.startsWith('GET')).length;
  return { item, fetch, calls, labels, writes };
}
const runOn = (request: Parameters<typeof handleGithubOperation>[0], fake: { fetch: Fetch }) =>
  handleGithubOperation(request, { token: 'secret', fetch: fake.fetch });
const add = (name: string, kind: 'issue' | 'pr' = 'issue') =>
  ({
    operationId: `add-${name}`,
    op: 'workitem.label.add',
    subject: { kind, ref },
    name,
  }) satisfies ForgeMutationRequest;
const remove = (name: string, kind: 'issue' | 'pr' = 'issue') =>
  ({
    operationId: `remove-${name}`,
    op: 'workitem.label.remove',
    subject: { kind, ref },
    name,
  }) satisfies ForgeMutationRequest;

test('two concurrent single-label adds both survive where two whole-set writes lose one', async () => {
  const adds = labelForge({ interleave: true });
  const added = await Promise.all([runOn(add('a'), adds), runOn(add('b'), adds)]);
  expect(added.map(response => response.ok)).toEqual([true, true]);
  expect(adds.labels()).toEqual(['a', 'b', 'other']);

  // Each caller extends the set it read, which is what a whole-set replacement asks of it.
  const sets = labelForge({ interleave: true });
  await Promise.all(
    ['a', 'b'].map(name =>
      runOn(
        { operationId: `set-${name}`, op: 'workitem.labels.set', ref, labels: ['other', name] },
        sets
      )
    )
  );
  expect(sets.labels()).toHaveLength(2);
  expect(sets.labels()).toContain('other');
});

test('removing one label leaves the others, and an absent label is already removed', async () => {
  const fake = labelForge();
  fake.item.labels.push({ name: 'queued' });
  expect(await runOn(remove('queued'), fake)).toMatchObject({
    ok: true,
    result: { value: { outcome: 'applied', changed: true, labels: ['other'] } },
  });
  expect(fake.calls).toContain(`DELETE ${root}/issues/1/labels/queued`);
  expect(fake.labels()).toEqual(['other']);
  expect(await runOn(remove('queued'), fake)).toMatchObject({
    ok: true,
    result: { value: { changed: false, labels: ['other'] } },
  });
  expect(fake.writes()).toBe(1);
});

test('a label another writer removed between the read and the delete is reported unchanged', async () => {
  const fake = labelForge({ interleave: true });
  fake.item.labels.push({ name: 'queued' });
  const results = await Promise.all([runOn(remove('queued'), fake), runOn(remove('queued'), fake)]);
  expect(results.map(response => response.ok)).toEqual([true, true]);
  const changed = results.map(response =>
    response.ok && response.result.op === 'workitem.label.remove'
      ? response.result.value.changed
      : null
  );
  expect(changed.sort()).toEqual([false, true]);
  expect(fake.labels()).toEqual(['other']);
});

test('a pull request is labelled by its pull request reference', async () => {
  const fake = labelForge({ kind: 'pr' });
  expect(await runOn(add('queued', 'pr'), fake)).toMatchObject({
    ok: true,
    result: { value: { outcome: 'applied', changed: true, workitem: { kind: 'pr', ref } } },
  });
  expect(fake.labels()).toEqual(['other', 'queued']);
  // Whole-set replacement still addresses issues only.
  expect(
    await runOn({ operationId: 'set', op: 'workitem.labels.set', ref, labels: [] }, fake)
  ).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
  expect(fake.writes()).toBe(1);
});

test('a subject of the wrong kind or a label the repository lacks is refused before writing', async () => {
  const fake = labelForge({ kind: 'pr' });
  expect(await runOn(add('queued', 'issue'), fake)).toMatchObject({
    ok: false,
    error: { kind: 'invalid_request' },
    mutation: { outcome: 'refused' },
  });
  expect(await runOn(remove('other', 'issue'), fake)).toMatchObject({
    ok: false,
    mutation: { outcome: 'refused' },
  });
  for (const name of ['missing', 'Queued'])
    expect(await runOn(add(name, 'pr'), fake)).toMatchObject({
      ok: false,
      error: { kind: 'not_found' },
      mutation: { outcome: 'refused' },
    });
  expect(fake.writes()).toBe(0);
});

test('single-label writes pass conformance for applied and verification failure', async () => {
  for (const [request, seed] of [
    [add('queued', 'pr'), []],
    [remove('queued', 'pr'), ['queued']],
  ] as const) {
    for (const [lose, expectedOutcome] of [
      [false, 'applied'],
      [true, 'verification_failed'],
    ] as const) {
      const fake = labelForge({ kind: 'pr', lose });
      for (const name of seed) fake.item.labels.push({ name });
      expect(
        await runForgeMutationConformance(req => runOn(req, fake), githubPluginMetadata, [
          { name: `${request.op}:${expectedOutcome}`, request, expectedOutcome },
        ])
      ).toEqual([]);
    }
  }
});

test('listing by label returns open issues and pull requests across pages', async () => {
  const row = (number: number, labels: string[], extra: object = {}) => ({
    number,
    repository_url: root,
    html_url: `https://github.com/owner/repo/issues/${String(number)}`,
    title: 'secret title',
    body: null,
    state: 'open',
    labels: labels.map(name => ({ name })),
    ...extra,
  });
  const pageOne = Array.from({ length: 100 }, (_, index) => row(index + 1, ['queued']));
  const urls: URL[] = [];
  const fake = {
    fetch: async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      urls.push(url);
      return Response.json(
        url.searchParams.get('page') === '1'
          ? pageOne
          : // GitHub's label filter is case-insensitive; the seam's names are not.
            [row(101, ['queued'], { pull_request: {} }), row(102, ['Queued'])]
      );
    },
  };
  const response = await runOn(
    { operationId: 'list', op: 'workitem.list', repo, label: 'queued' },
    fake
  );
  if (!response.ok || response.result.op !== 'workitem.list') throw new Error('expected a list');
  const items = response.result.value.items;
  expect(items).toHaveLength(101);
  expect(items.at(-1)).toEqual({
    ref: { repo, number: 101 },
    kind: 'pr',
    url: 'https://github.com/owner/repo/issues/101',
    state: 'open',
  });
  expect(items.filter(item => item.kind === 'issue')).toHaveLength(100);
  expect(urls.map(url => url.searchParams.get('page'))).toEqual(['1', '2']);
  for (const url of urls) {
    expect(url.pathname).toBe('/repos/owner/repo/issues');
    expect(url.searchParams.get('state')).toBe('open');
    expect(url.searchParams.get('labels')).toBe('queued');
  }
  expect(
    await runOn({ operationId: 'list', op: 'workitem.list', repo, label: 'a,b' }, fake)
  ).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
  expect(urls).toHaveLength(2);
});

test('an item view returns its author, and a response without one reports none', async () => {
  const fake = labelForge({ kind: 'pr' });
  expect(await runOn({ operationId: 'view', op: 'workitem.view', ref }, fake)).toMatchObject({
    ok: true,
    result: {
      value: { kind: 'pr', author: { host: 'github.com', id: '42', login: 'octo' } },
    },
  });
  const anonymous = labelForge();
  Object.assign(anonymous.item, { user: null });
  expect(await runOn({ operationId: 'view', op: 'workitem.view', ref }, anonymous)).toMatchObject({
    ok: true,
    result: { value: { author: null } },
  });
  const { user: _user, ...withoutUser } = anonymous.item;
  const legacy = { fetch: async () => Response.json(withoutUser) };
  const response = await runOn({ operationId: 'view', op: 'workitem.view', ref }, legacy);
  expect(response.ok && response.result.value).not.toHaveProperty('author');
});
