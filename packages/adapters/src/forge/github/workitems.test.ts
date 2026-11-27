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
  const issueList = (method: string, init?: RequestInit) => {
    if (method === 'POST') {
      const payload = JSON.parse(String(init?.body)) as { title: string; body: string };
      if (mode !== 'unverified') issues.push({ ...issue, ...payload });
      if (mode === 'lost-create') throw new Error('committed but response lost');
      return Response.json(issue, { status: 201 });
    }
    return Response.json(issues);
  };
  const setLabels = (init?: RequestInit) => {
    if (mode !== 'unverified')
      issue.labels = (JSON.parse(String(init?.body)) as { labels: string[] }).labels.map(name => ({
        name,
      }));
    return Response.json(issue.labels);
  };
  const readIssue = () => {
    if (mode === 'read-failed' && writes > 0) return Response.json({}, { status: 500 });
    return issues[0] ? Response.json(issues[0]) : Response.json({}, { status: 404 });
  };
  const repositoryLabels = (method: string, init?: RequestInit) => {
    if (method === 'POST' && mode !== 'unverified')
      labels.push(JSON.parse(String(init?.body)) as (typeof labels)[number]);
    return Response.json(labels);
  };
  const labelByName = (url: URL) => {
    const label = labels.find(
      row => row.name === decodeURIComponent(url.pathname.split('/').pop() ?? '')
    );
    return label ? Response.json(label) : Response.json({}, { status: 404 });
  };
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
    if (path === 'https://api.github.com/search/issues') {
      return Response.json({
        total_count: issues.length,
        incomplete_results: false,
        items: issues,
      });
    }
    if (path === `${root}/issues`) {
      return issueList(method, init);
    }
    if (path === `${root}/issues/1`) {
      return readIssue();
    }
    if (path === `${root}/issues/1/labels`) {
      return setLabels(init);
    }
    if (path === `${root}/labels`) {
      return repositoryLabels(method, init);
    }
    if (path.startsWith(`${root}/labels/`)) {
      return labelByName(url);
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

test('marker lookup finds an old issue by search and a new one search has not indexed, never a PR', async () => {
  const fake = fixture();
  const baseFetch = fake.fetch;
  const lookup = async (
    searched: unknown[],
    newest: unknown[],
    incomplete = false,
    total = searched.length
  ) => {
    fake.fetch = async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? 'GET') === 'GET' && url.pathname === '/search/issues') {
        // Only a search for the marker's words in issue bodies of this repository finds it.
        const asked = url.searchParams.get('q') === 'repo:owner/repo is:issue in:body "canonical"';
        return Response.json({
          total_count: total,
          incomplete_results: incomplete,
          items: asked ? searched : [],
        });
      }
      if ((init?.method ?? 'GET') === 'GET' && url.pathname.endsWith('/issues')) {
        // Only the newest-first page holds a just-created issue.
        const newestFirst =
          url.searchParams.get('sort') === 'created' &&
          url.searchParams.get('direction') === 'desc';
        return Response.json(newestFirst ? newest : []);
      }
      return baseFetch(input, init);
    };
    return run(create, fake);
  };
  fake.seed();
  const unmarked = { ...fake.issue, number: 2, body: 'unmarked' };
  const found = { ok: true, result: { value: { changed: false } } };
  // Older than the newest hundred: only search sees it.
  expect(await lookup([fake.issue], [unmarked])).toMatchObject(found);
  // Created moments ago, before search indexed it.
  expect(await lookup([], [fake.issue])).toMatchObject(found);
  // Found by both: one issue, not a conflict.
  expect(await lookup([fake.issue], [fake.issue])).toMatchObject(found);
  // A partial search cannot show the marker is absent, so nothing is created.
  expect(await lookup([unmarked], [], true)).toMatchObject({
    ok: false,
    mutation: { outcome: 'refused' },
  });
  // A full page with more matches beyond it cannot show the marker is absent either.
  expect(await lookup([unmarked], [], false, 101)).toMatchObject({
    ok: false,
    mutation: { outcome: 'refused' },
  });
  expect(fake.writes()).toBe(0);
  // A pull request carrying the marker is not the issue.
  expect(await lookup([{ ...fake.issue, pull_request: {} }], [])).toMatchObject({
    ok: true,
    result: { value: { changed: true } },
  });
});

test('a marker cannot add search qualifiers or outgrow the query limit', async () => {
  const fake = fixture();
  const long = `<!-- a" is:closed "b ${'word '.repeat(60)}-->`;
  const queries: string[] = [];
  const baseFetch = fake.fetch;
  fake.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/search/issues') queries.push(url.searchParams.get('q') ?? '');
    return baseFetch(input, init);
  };
  await run(forgeRequestSchema.parse({ ...create, marker: long, body: `${long}\nBody` }), fake);
  const phrase = queries[0]?.match(/"(.*)"$/)?.[1] ?? '';
  expect(phrase).not.toContain('"');
  expect(phrase.length).toBeLessThanOrEqual(200);
  // Quotes gone, so `is:closed` stays inside the phrase; cut after a whole word.
  expect(phrase.startsWith('a is:closed b word')).toBe(true);
  expect(phrase.endsWith(' word')).toBe(true);
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
  const addLabels = (init?: RequestInit) => {
    for (const name of (JSON.parse(String(init?.body)) as { labels: string[] }).labels)
      if (!item.labels.some(label => label.name === name)) item.labels.push({ name });
  };
  const writeLabels = async (url: URL, method: string, init?: RequestInit) => {
    if (options.interleave) await bothRead.promise;
    if (method === 'PUT' && !options.lose) {
      const names = (JSON.parse(String(init?.body)) as { labels: string[] }).labels;
      item.labels = names.map(name => ({ name }));
    }
    if (method === 'POST' && !options.lose) {
      addLabels(init);
    }
    if (method === 'DELETE') {
      const name = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      if (!item.labels.some(label => label.name === name))
        return Response.json({ message: 'Label does not exist' }, { status: 404 });
      if (!options.lose) item.labels = item.labels.filter(label => label.name !== name);
    }
    return Response.json(item.labels);
  };
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
      return writeLabels(url, method, init);
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
    updated_at: `2026-01-01T00:00:${String(number % 60).padStart(2, '0')}Z`,
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
    updatedAt: '2026-01-01T00:00:41Z',
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

test('the latest add of the exact label is read across pages; a label never added reads none', async () => {
  const event = (id: number, name: string, at: string, kind = 'labeled') => ({
    id,
    event: kind,
    created_at: at,
    actor: { id: 7, login: 'maintainer', type: 'User' },
    label: { name, color: 'abcdef' },
  });
  const pageOne = [
    event(1, 'factory', '2026-11-20T10:00:00Z'),
    event(2, 'factory', '2026-11-21T10:00:00Z', 'unlabeled'),
    ...Array.from({ length: 98 }, (_, index) =>
      event(100 + index, 'other', '2026-11-21T11:00:00Z')
    ),
  ];
  const urls: URL[] = [];
  const fake = {
    fetch: async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      urls.push(url);
      return Response.json(
        url.searchParams.get('page') === '1'
          ? pageOne
          : [
              event(3, 'factory', '2026-11-22T10:00:00Z'),
              event(4, 'Factory', '2026-11-23T10:00:00Z'),
            ]
      );
    },
  };
  const subject = { kind: 'issue' as const, ref };
  const read = (name: string) =>
    runOn({ operationId: 'added', op: 'workitem.label.added', subject, name }, fake);
  expect(await read('factory')).toMatchObject({
    ok: true,
    result: {
      op: 'workitem.label.added',
      value: {
        subject,
        name: 'factory',
        added: {
          id: '3',
          at: '2026-11-22T10:00:00Z',
          actor: { host: 'github.com', id: '7', login: 'maintainer', type: 'user' },
        },
      },
    },
  });
  expect(urls[0]?.pathname).toBe('/repos/owner/repo/issues/1/events');
  expect(await read('missing')).toMatchObject({ ok: true, result: { value: { added: null } } });
});

test('opened issues are read newest first down to the cutoff, without pull requests', async () => {
  const row = (number: number, createdAt: string, pr = false) => ({
    number,
    repository_url: 'https://api.github.com/repos/owner/repo',
    labels: [],
    html_url: `https://github.com/owner/repo/issues/${String(number)}`,
    title: 'new',
    body: null,
    state: 'open',
    created_at: createdAt,
    user: { id: 7, login: 'reporter', type: 'User' },
    ...(pr ? { pull_request: {} } : {}),
  });
  // A full first page, all at or after the cutoff and one a pull request; the second page
  // reaches an issue created before it, so no third page is read.
  const pageOne = Array.from({ length: 100 }, (_, index) =>
    row(300 - index, '2026-11-23T12:00:00Z', index === 1)
  );
  const pageTwo = [row(200, '2026-11-23T10:00:00Z'), row(199, '2026-11-23T09:00:00Z')];
  const urls: URL[] = [];
  const fake = {
    fetch: async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      urls.push(url);
      return Response.json(url.searchParams.get('page') === '1' ? pageOne : pageTwo);
    },
  };
  const since = '2026-11-23T10:00:00Z';
  const response = await runOn({ operationId: 'opened', op: 'workitem.opened', repo, since }, fake);
  if (!response.ok || response.result.op !== 'workitem.opened') throw new Error('read failed');
  const { items } = response.result.value;
  expect(items.map(item => item.ref.number)).not.toContain(299);
  expect(items).toHaveLength(100);
  expect(items.at(-1)).toEqual({
    ref: { repo, number: 200 },
    kind: 'issue',
    url: 'https://github.com/owner/repo/issues/200',
    state: 'open',
    createdAt: since,
    author: { host: 'github.com', id: '7', login: 'reporter', type: 'user' },
  });
  expect(urls.map(url => url.searchParams.get('page'))).toEqual(['1', '2']);
  for (const url of urls) {
    expect(url.pathname).toBe('/repos/owner/repo/issues');
    expect(url.searchParams.get('state')).toBe('open');
    expect(url.searchParams.get('sort')).toBe('created');
    expect(url.searchParams.get('direction')).toBe('desc');
    expect(url.searchParams.get('since')).toBe(since);
  }
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

/** One GitHub item with its conversation comments and close state. */
function conversationForge(
  options: {
    kind?: 'issue' | 'pr';
    lose?: boolean;
    /** The `issue_url` the instance reports, when it builds one from another host. */
    issueUrl?: (number: number) => string;
  } = {}
) {
  const item = {
    number: 1,
    repository_url: root,
    html_url: 'https://github.com/owner/repo/issues/1',
    title: 'Title',
    body: 'Body',
    state: 'open',
    state_reason: null as string | null,
    labels: [],
    ...(options.kind === 'pr' ? { pull_request: {} } : {}),
  };
  const comments: { id: number; html_url: string; issue_url: string; body: string }[] = [];
  const calls: string[] = [];
  const commentList = (url: URL, method: string, body: Record<string, string>) => {
    if (method === 'GET')
      return Response.json(url.searchParams.get('page') === '1' ? comments : []);
    const comment = {
      id: 900 + comments.length,
      html_url: `https://github.com/owner/repo/issues/1#issuecomment-${String(900 + comments.length)}`,
      issue_url: options.issueUrl?.(1) ?? `${root}/issues/1`,
      body: body.body,
    };
    if (!options.lose) comments.push(comment);
    return Response.json(comment, { status: 201 });
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.origin + url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    if (path === `${root}/issues/1`) {
      if (method === 'PATCH' && !options.lose)
        Object.assign(item, { state: body.state, state_reason: body.state_reason });
      return Response.json(item);
    }
    if (path === `${root}/issues/1/comments`) {
      return commentList(url, method, body);
    }
    if (path.startsWith(`${root}/issues/comments/`)) {
      const comment = comments.find(row => String(row.id) === url.pathname.split('/').pop());
      if (!comment) return Response.json({}, { status: 404 });
      if (method === 'PATCH') comment.body = body.body;
      return Response.json(comment);
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const writes = (): number => calls.filter(call => !call.startsWith('GET')).length;
  return { item, comments, fetch, calls, writes };
}
const commentOn = (kind: 'issue' | 'pr', body: string) =>
  ({
    operationId: `comment-${kind}`,
    op: 'workitem.comment.upsert',
    subject: { kind, ref },
    marker,
    body: `${marker}\n${body}`,
  }) satisfies ForgeMutationRequest;
const close = (reason: 'completed' | 'not_planned' | 'duplicate') =>
  ({
    operationId: `close-${reason}`,
    op: 'workitem.close',
    ref,
    reason,
  }) satisfies ForgeMutationRequest;

test('a comment read back from an instance that names another host still verifies', async () => {
  // GitHub Enterprise Server builds `issue_url` from its own configured public URL, so a client
  // that reaches it by a second name (a proxy, a LAN address) used to fail a write that succeeded.
  const fake = conversationForge({
    issueUrl: number => `https://ghe.corp.example/api/v3/repos/owner/repo/issues/${String(number)}`,
  });
  expect(await runOn(commentOn('issue', 'first'), fake)).toMatchObject({
    ok: true,
    result: { value: { outcome: 'applied' } },
  });
});

test('a comment read back for another repository with the same number still fails verification', async () => {
  const fake = conversationForge({
    issueUrl: () => 'https://api.github.com/repos/owner/other/issues/1',
  });
  expect(await runOn(commentOn('issue', 'first'), fake)).toMatchObject({
    ok: false,
    error: { kind: 'invalid_response', message: expect.stringContaining('did not match') },
  });
});

test('a comment read back for another item still fails verification', async () => {
  const fake = conversationForge({
    issueUrl: () => 'https://api.github.com/repos/owner/repo/issues/2',
  });
  expect(await runOn(commentOn('issue', 'first'), fake)).toMatchObject({
    ok: false,
    error: { kind: 'invalid_response', message: expect.stringContaining('did not match') },
  });
});

test('an issue is commented on by its issue reference, and the marked comment is updated in place', async () => {
  const fake = conversationForge();
  expect(await runOn(commentOn('issue', 'first'), fake)).toMatchObject({
    ok: true,
    result: {
      value: {
        outcome: 'applied',
        changed: true,
        workitem: { kind: 'issue', ref },
        comment: { ref },
      },
    },
  });
  expect(await runOn(commentOn('issue', 'first'), fake)).toMatchObject({
    ok: true,
    result: { value: { changed: false } },
  });
  expect(await runOn(commentOn('issue', 'second'), fake)).toMatchObject({
    ok: true,
    result: { value: { changed: true } },
  });
  expect(fake.comments.map(comment => comment.body)).toEqual([`${marker}\nsecond`]);
  expect(fake.calls.filter(call => !call.startsWith('GET'))).toEqual([
    `POST ${root}/issues/1/comments`,
    `PATCH ${root}/issues/comments/900`,
  ]);
});

test('a comment whose subject kind does not match the item is refused before writing', async () => {
  const fake = conversationForge({ kind: 'pr' });
  expect(await runOn(commentOn('issue', 'text'), fake)).toMatchObject({
    ok: false,
    error: { kind: 'invalid_request' },
    mutation: { outcome: 'refused' },
  });
  expect(await runOn(commentOn('pr', 'text'), fake)).toMatchObject({
    ok: true,
    result: { value: { workitem: { kind: 'pr' } } },
  });
  expect(fake.writes()).toBe(1);
});

test('closing an issue records its reason, and a different earlier reason is refused', async () => {
  const fake = conversationForge();
  expect(await runOn(close('duplicate'), fake)).toMatchObject({
    ok: true,
    result: {
      value: {
        outcome: 'applied',
        changed: true,
        reason: 'duplicate',
        workitem: { kind: 'issue', state: 'closed' },
      },
    },
  });
  expect(fake.calls).toContain(`PATCH ${root}/issues/1`);
  expect(await runOn(close('duplicate'), fake)).toMatchObject({
    ok: true,
    result: { value: { changed: false } },
  });
  expect(await runOn(close('completed'), fake)).toMatchObject({
    ok: false,
    error: { kind: 'conflict' },
    mutation: { outcome: 'refused' },
  });
  expect(fake.writes()).toBe(1);

  const pr = conversationForge({ kind: 'pr' });
  expect(await runOn(close('not_planned'), pr)).toMatchObject({
    ok: false,
    error: { kind: 'invalid_request' },
    mutation: { outcome: 'refused' },
  });
  expect(pr.writes()).toBe(0);
});

test('issue comments and closes pass conformance for applied and verification failure', async () => {
  for (const request of [commentOn('issue', 'text'), close('completed')])
    for (const [lose, expectedOutcome] of [
      [false, 'applied'],
      [true, 'verification_failed'],
    ] as const)
      expect(
        await runForgeMutationConformance(
          req => runOn(req, conversationForge({ lose })),
          githubPluginMetadata,
          [{ name: `${request.op}:${expectedOutcome}`, request, expectedOutcome }]
        )
      ).toEqual([]);
});

/**
 * `ignore` answers an assignee write with the issue unchanged, as GitHub does for a caller
 * without push access. `lose` answers as if the write landed while the issue stays as it was.
 * `cut` applies the write and breaks the response body after its success status.
 */
function assigneeForge(options: { kind?: 'issue' | 'pr'; mode?: 'ignore' | 'lose' | 'cut' } = {}) {
  const item = {
    number: 1,
    repository_url: root,
    html_url: 'https://github.com/owner/repo/issues/1',
    title: 'Title',
    body: 'Body',
    state: 'open',
    labels: [],
    assignees: [{ login: 'Other' }],
    ...(options.kind === 'pr' ? { pull_request: {} } : {}),
  };
  // Who GitHub would assign on this issue; a commenter is assignable here but has no
  // repository access, so the repository-wide check refuses them.
  const assignable = new Set(['other', 'octo', 'commenter']);
  const calls: string[] = [];
  const status = (ok: boolean) =>
    ok ? new Response(null, { status: 204 }) : Response.json({}, { status: 404 });
  const broken = (code: number) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('connection reset'));
        },
      }),
      { status: code }
    );
  const write = (method: string, init?: RequestInit): Response => {
    const { assignees } = JSON.parse(String(init?.body)) as { assignees: string[] };
    const named = new Set(assignees.map(name => name.toLowerCase()));
    const next =
      method === 'POST'
        ? [...item.assignees, ...assignees.map(name => ({ login: name }))]
        : item.assignees.filter(row => !named.has(row.login.toLowerCase()));
    const code = method === 'POST' ? 201 : 200;
    if (options.mode === 'ignore') return Response.json(item, { status: code });
    if (options.mode === 'lose')
      return Response.json({ ...item, assignees: next }, { status: code });
    item.assignees = next;
    return options.mode === 'cut' ? broken(code) : Response.json(item, { status: code });
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.origin + url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const login = decodeURIComponent(url.pathname.split('/').pop() ?? '').toLowerCase();
    if (path === `${root}/issues/1`) return Response.json(structuredClone(item));
    if (path.startsWith(`${root}/issues/1/assignees/`)) return status(assignable.has(login));
    if (path.startsWith(`${root}/assignees/`))
      return status(login !== 'commenter' && assignable.has(login));
    if (path === `${root}/issues/1/assignees`) return write(method, init);
    throw new Error(`unexpected ${method} ${path}`);
  };
  const assigned = (): string[] => item.assignees.map(row => row.login);
  const writes = (): number => calls.filter(call => !call.startsWith('GET')).length;
  return { item, fetch, calls, assigned, writes };
}
const assign = (login: string) =>
  ({
    operationId: `assign-${login}`,
    op: 'workitem.assignee.add',
    ref,
    login,
  }) satisfies ForgeMutationRequest;
const unassign = (login: string) =>
  ({
    operationId: `unassign-${login}`,
    op: 'workitem.assignee.remove',
    ref,
    login,
  }) satisfies ForgeMutationRequest;

test('assigning a user keeps the existing assignees, and an assigned login in another case changes nothing', async () => {
  const fake = assigneeForge();
  expect(await runOn(assign('octo'), fake)).toMatchObject({
    ok: true,
    result: {
      value: {
        outcome: 'applied',
        changed: true,
        workitem: { kind: 'issue', ref },
        assignees: ['Other', 'octo'],
      },
    },
  });
  expect(fake.calls).toContain(`POST ${root}/issues/1/assignees`);
  expect(await runOn(assign('OCTO'), fake)).toMatchObject({
    ok: true,
    result: { value: { changed: false, assignees: ['Other', 'octo'] } },
  });
  expect(fake.writes()).toBe(1);
});

test('a user assignable on the issue but not across the repository is assigned', async () => {
  const fake = assigneeForge();
  expect(await runOn(assign('commenter'), fake)).toMatchObject({
    ok: true,
    result: { value: { outcome: 'applied', assignees: ['Other', 'commenter'] } },
  });
});

test('a user GitHub would not assign is refused with the reason and nothing is written', async () => {
  const fake = assigneeForge();
  const response = await runOn(assign('stranger'), fake);
  expect(response).toMatchObject({
    ok: false,
    error: { kind: 'not_found' },
    mutation: { outcome: 'refused' },
  });
  expect(!response.ok && response.error.message).toContain('stranger cannot be assigned');
  expect(!response.ok && response.error.message).toContain('access to the repository');
  expect(fake.writes()).toBe(0);
  expect(fake.assigned()).toEqual(['Other']);
});

test('an assignee write GitHub answers with the login unchanged is refused with what it showed', async () => {
  const fake = assigneeForge({ mode: 'ignore' });
  for (const [request, state] of [
    [assign('octo'), 'left octo unassigned'],
    [unassign('other'), 'left other assigned'],
  ] as const) {
    const response = await runOn(request, fake);
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: { outcome: 'refused' },
    });
    expect(!response.ok && response.error.message).toContain(state);
    // The ten-assignee limit caps adds only, so it cannot explain a failed removal.
    expect(!response.ok && response.error.message.includes('ten assignees')).toBe(
      request.op === 'workitem.assignee.add'
    );
  }
  expect(fake.assigned()).toEqual(['Other']);
});

test('an acknowledged assignee write whose response body breaks is decided by reading the issue', async () => {
  for (const [request, assignees] of [
    [assign('octo'), ['Other', 'octo']],
    [unassign('other'), []],
  ] as const)
    expect(await runOn(request, assigneeForge({ mode: 'cut' }))).toMatchObject({
      ok: true,
      result: { value: { outcome: 'applied', changed: true, assignees } },
    });
});

test('unassigning removes only that user, and an absent user is already unassigned', async () => {
  const fake = assigneeForge();
  fake.item.assignees.push({ login: 'octo' });
  expect(await runOn(unassign('Octo'), fake)).toMatchObject({
    ok: true,
    result: { value: { outcome: 'applied', changed: true, assignees: ['Other'] } },
  });
  expect(await runOn(unassign('octo'), fake)).toMatchObject({
    ok: true,
    result: { value: { changed: false, assignees: ['Other'] } },
  });
  expect(fake.writes()).toBe(1);
});

test('assignee writes refuse a pull request before writing', async () => {
  const fake = assigneeForge({ kind: 'pr' });
  for (const request of [assign('octo'), unassign('other')])
    expect(await runOn(request, fake)).toMatchObject({
      ok: false,
      error: { kind: 'invalid_request' },
      mutation: { outcome: 'refused' },
    });
  expect(fake.writes()).toBe(0);
});

test('the read-back after an assignee write decides the outcome, not the write response', async () => {
  for (const request of [assign('octo'), unassign('other')])
    for (const [mode, expectedOutcome] of [
      [undefined, 'applied'],
      ['lose', 'verification_failed'],
    ] as const)
      expect(
        await runForgeMutationConformance(
          req => runOn(req, assigneeForge({ mode })),
          githubPluginMetadata,
          [{ name: `${request.op}:${expectedOutcome}`, request, expectedOutcome }]
        )
      ).toEqual([]);
});

test('the acting account is read with the credential and can be assigned by its login', async () => {
  const fake = assigneeForge();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(input) !== 'https://api.github.com/user') return fake.fetch(input, init);
    return new Headers(init?.headers).get('authorization') === 'Bearer secret'
      ? Response.json({ id: 7, login: 'octo', type: 'User' })
      : Response.json({ message: 'Requires authentication' }, { status: 401 });
  };
  const self = await runOn({ operationId: 'self', op: 'actor.self', repo }, { fetch });
  expect(self).toEqual({
    operationId: 'self',
    ok: true,
    result: {
      op: 'actor.self',
      value: { repo, actor: { host: 'github.com', id: '7', login: 'octo', type: 'user' } },
    },
  });
  if (!self.ok || self.result.op !== 'actor.self') throw new Error('actor.self failed');
  expect(await runOn(assign(self.result.value.actor.login), { fetch })).toMatchObject({
    ok: true,
    result: { value: { outcome: 'applied', assignees: ['Other', 'octo'] } },
  });
});
