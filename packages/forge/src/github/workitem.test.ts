import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { ForgeDispatcher } from '../dispatch/dispatcher';
import { publicRequestSchema, type ForgeOpAuditEvent } from '../schemas';
import { workItemFixture } from '../test/workitem-fixture';

const track = trackTempRoots();
let f: ReturnType<typeof workItemFixture>;
let root: string;
let audits: ForgeOpAuditEvent[];
let dispatcher: ForgeDispatcher;
const marker = `<!-- archon-discovery:${'a'.repeat(64)} -->`;
const content = 'Unicode café é 🦊 東京 `literal` $(data)';
beforeEach(async () => {
  f = workItemFixture();
  root = track(await mkdtemp(join(tmpdir(), 'forge work items ')));
  await writeFile(join(root, 'forge.json'), JSON.stringify({ hosts: {} }));
  audits = [];
  dispatcher = new ForgeDispatcher(
    [
      {
        source: 'fixture:github',
        command: process.execPath,
        args: [join(import.meta.dir, '../dispatch/fixtures/github-plugin.ts'), f.server.url.origin],
      },
    ],
    {
      cwd: root,
      env: { GH_TOKEN: 'fixture-secret', ARTIFACTS_DIR: root },
      discoverHome: async () => [],
      discoverPath: async () => [],
      audit: event => {
        audits.push(event);
      },
    }
  );
});
afterEach(async () => {
  await f.server.stop(true);
});
function dispatch(request: unknown) {
  return dispatcher.publicOperation(publicRequestSchema.parse(request));
}
function create(overrides = {}) {
  return dispatch({
    op: 'workitem.create',
    repo: f.repo,
    marker,
    title: content,
    body: content,
    ...overrides,
  });
}
function fillPages() {
  f.items.splice(0, f.items.length, ...Array.from({ length: 201 }, (_, i) => f.makeItem(i + 1)));
  f.items[200].body = `${marker}\nOriginal public body`;
  f.items[200].state = 'closed';
}
test('exact marker recovery scans beyond page one including closed items and preserves content', async () => {
  fillPages();
  f.items[0].body = `Mention\n${marker}`;
  const result = await create();
  expect(result).toMatchObject({
    kind: 'ok',
    value: {
      ref: { number: 201 },
      title: 'Work item',
      body: `${marker}\nOriginal public body`,
      state: 'closed',
    },
  });
  expect(f.calls.some(call => call.path.endsWith('page=3'))).toBe(true);
  expect(f.calls.every(call => call.method === 'GET')).toBe(true);
});
test('bounded search reports incomplete enumeration and creation refuses even an early match', async () => {
  fillPages();
  expect(
    await dispatch({ op: 'workitem.search', repo: f.repo, marker, max_pages: 1 })
  ).toMatchObject({
    kind: 'ok',
    value: { items: [], pages: 1, completeness: 'truncated' },
  });
  f.items[0].body = marker;
  expect(await create({ max_pages: 1 })).toMatchObject({
    kind: 'error',
    error: {
      kind: 'verify_failed',
      observed: 'pagination bound reached; marker uniqueness unknown',
    },
  });
  expect(f.calls.every(call => call.method === 'GET')).toBe(true);
});
test('unfiltered search returns qualified content for semantic judgment, excluding PRs', async () => {
  f.items[0].body = content;
  f.items.push({
    ...f.makeItem(43),
    html_url: 'https://github.com/owner/repo/pull/43',
    ...{ pull_request: {} },
  });
  expect(await dispatch({ op: 'workitem.search', repo: f.repo })).toMatchObject({
    kind: 'ok',
    value: {
      repo: f.repo,
      completeness: 'complete',
      items: [{ ref: { repo: f.repo, number: 42 }, body: content }],
    },
  });
});
test('multiple markers across pages refuse creation', async () => {
  fillPages();
  f.items[0].body = marker;
  expect(await create()).toMatchObject({
    kind: 'error',
    error: { kind: 'verify_failed', observed: 'duplicate markers; operator must reconcile' },
  });
  expect(f.calls.every(call => call.method === 'GET')).toBe(true);
});
test('accepted create with lost response retries the same marker without rewriting public content', async () => {
  f.state.mode = 'write_then_fail';
  expect(await create()).toMatchObject({
    kind: 'error',
    error: {
      kind: 'verify_failed',
      leave_behind: expect.stringContaining('Write may have been accepted'),
    },
  });
  f.state.mode = '';
  expect(await create({ title: 'Changed', body: 'Changed' })).toMatchObject({
    kind: 'ok',
    value: { ref: { repo: f.repo, number: 43 }, title: content, body: `${marker}\n${content}` },
  });
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  expect(JSON.stringify(audits)).not.toContain(content);
  expect(JSON.stringify(audits)).not.toContain('fixture-secret');
  expect(audits.map(event => event.target)).toEqual([
    'github.com/owner/repo',
    'github.com/owner/repo',
  ]);
});
test.each(['missing_marker', 'wrong_create', 'wrong_after', 'read_failure'])(
  'create read-back refuses %s as an uncertain write',
  async mode => {
    f.state.mode = mode;
    expect(await create()).toMatchObject({
      kind: 'error',
      error: { kind: 'verify_failed', leave_behind: expect.any(String) },
    });
  }
);
test('wrong repository and duplicate pagination identities refuse before creation', async () => {
  f.items[0].html_url = 'https://github.com/wrong/repo/issues/42';
  expect(await create()).toMatchObject({ kind: 'error', error: { kind: 'verify_failed' } });
  fillPages();
  f.items[100] = f.items[0];
  expect(await create()).toMatchObject({
    kind: 'error',
    error: { kind: 'verify_failed', observed: 'listing repeated an item' },
  });
  expect(f.calls.every(call => call.method === 'GET')).toBe(true);
});
test('schema rejects missing, malformed and repeated caller markers and invalid identities', () => {
  for (const request of [
    { marker: undefined },
    { marker: '' },
    { marker: 'some prose' },
    { marker: `${marker}\n` },
    { body: marker },
    { repo: { host: 'github.com', path: 'owner/../repo' } },
    { max_pages: 101 },
  ])
    expect(
      publicRequestSchema.safeParse({
        op: 'workitem.create',
        repo: f.repo,
        marker,
        title: 'Title',
        body: '',
        ...request,
      }).success
    ).toBe(false);
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(
      publicRequestSchema.safeParse({ op: 'workitem.view', ref: { repo: f.repo, number } }).success
    ).toBe(false);
});
test('label delta preserves concurrent unrelated labels and encodes Unicode, slash and comma data', async () => {
  f.state.mode = 'concurrent_unrelated';
  f.items[0].labels.push({ name: 'area:old/cli,api' });
  const request = {
    op: 'workitem.labels',
    ref: { repo: f.repo, number: 42 },
    add: ['東京/cli,api'],
    remove: ['area:old/cli,api'],
  };
  expect(await dispatch(request)).toMatchObject({
    kind: 'ok',
    value: {
      labels: expect.arrayContaining([
        '東京/cli,api',
        'area:concurrent/cli,api',
        'unrelated-label',
      ]),
    },
  });
  expect(f.calls.find(call => call.method === 'DELETE')?.path).toEndWith('area%3Aold%2Fcli%2Capi');
  const writes = f.calls.filter(call => call.method !== 'GET').length;
  expect(await dispatch(request)).toMatchObject({ kind: 'ok' });
  expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(writes);
});
test('overlapping label deltas refuse case-insensitively', () => {
  expect(
    publicRequestSchema.safeParse({
      op: 'workitem.labels',
      ref: { repo: f.repo, number: 42 },
      add: ['Ready'],
      remove: ['ready'],
    }).success
  ).toBe(false);
});
test('content disclosure guard rejects credentials and artifacts before transport', async () => {
  for (const body of ['fixture-secret', root])
    expect(await create({ body })).toMatchObject({
      kind: 'error',
      error: { kind: 'invalid_request' },
    });
  expect(f.calls).toHaveLength(0);
});
test('label content and marker disclosure checks run before any write', async () => {
  expect(await create({ marker: '<!-- fixture-secret -->' })).toMatchObject({
    kind: 'error',
    error: { kind: 'invalid_request' },
  });
  for (const request of [
    { add: ['fixture-secret'], create: [] },
    { add: [], create: [{ name: 'safe', color: '123456', description: root }] },
  ])
    expect(
      await dispatch({
        op: 'workitem.labels',
        ref: { repo: f.repo, number: 42 },
        remove: [],
        ...request,
      })
    ).toMatchObject({ kind: 'error', error: { kind: 'invalid_request' } });
  expect(f.calls).toHaveLength(0);
});
test('native credential resolution reaches the real plugin and response redaction without changing host context', async () => {
  const env = { GH_CONFIG_DIR: join(root, 'native-config') };
  const subject = new ForgeDispatcher(
    [
      {
        source: 'fixture:github',
        command: process.execPath,
        args: [join(import.meta.dir, '../dispatch/fixtures/github-plugin.ts'), f.server.url.origin],
      },
    ],
    {
      cwd: root,
      env,
      discoverHome: async () => [],
      discoverPath: async () => [],
      resolveCredential: async host => {
        expect(host).toBe('github.com');
        return 'fixture-secret';
      },
    }
  );
  f.items[0].body = 'reflected fixture-secret';
  const result = await subject.publicOperation({
    op: 'workitem.view',
    ref: { repo: f.repo, number: 42 },
  });
  expect(result).toMatchObject({ kind: 'ok', value: { body: 'reflected [REDACTED]' } });
  expect(env).toEqual({ GH_CONFIG_DIR: join(root, 'native-config') });
});
test('CLI stdin uses real owner/plugin, Unicode and separate redacted audit', async () => {
  const cli = join(import.meta.dir, '../../../cli/src/commands/fixtures/forge-public-cli.ts');
  const run = async (op: string, request: unknown) => {
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        f.server.url.origin,
        'forge',
        'work-item',
        op,
        '--request',
        '-',
        '--json',
      ],
      {
        cwd: root,
        env: { ...process.env, ARCHON_HOME: root, GH_TOKEN: 'fixture-secret', GITHUB_TOKEN: '' },
        stdin: new Blob([JSON.stringify(request)]),
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  const created = await run('create', { repo: f.repo, marker, title: content, body: content });
  expect(created.code, created.stdout).toBe(0);
  expect(JSON.parse(created.stdout)).toMatchObject({ body: `${marker}\n${content}` });
  const searched = await run('search', { repo: f.repo, marker });
  expect(searched.code, searched.stdout).toBe(0);
  expect(JSON.parse(searched.stdout)).toMatchObject({
    completeness: 'complete',
    items: [JSON.parse(created.stdout)],
  });
  const invalid = await run('create', {
    repo: { host: 'github.com', path: 'owner/repo/extra' },
    marker,
    title: content,
    body: content,
  });
  expect(invalid.code).toBe(1);
  expect(created.stderr).toContain('"op":"workitem.create"');
  expect(created.stderr).not.toContain(content);
  expect(created.stdout + created.stderr + invalid.stdout + invalid.stderr).not.toContain(
    'fixture-secret'
  );
});
