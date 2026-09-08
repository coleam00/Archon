import { beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdtemp, writeFile, readFile, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { ForgeDispatcher } from '../dispatch/dispatcher';
import { createGitHubPlugin } from './plugin';
import { type PublicRequest, prRecordSchema } from '../schemas';

const track = trackTempRoots();
const exec = promisify(execFile);
const repo = { host: 'github.com', path: 'owner/repo' };
const ref = { repo, number: 42 };
const expected = { head_repo: repo, head: 'feature', base: 'dev', head_sha: 'a'.repeat(40) };
const create: Extract<PublicRequest, { op: 'pr.create' }> = {
  op: 'pr.create',
  repo,
  ...expected,
  title: 'A title',
  body: 'Body with `literal` $(data)',
  is_draft: true,
};
function fixture() {
  const repository = { full_name: repo.path, html_url: `https://github.com/${repo.path}` };
  const pr = {
    number: 42,
    node_id: 'PR_node',
    html_url: 'https://github.com/owner/repo/pull/42',
    title: create.title,
    body: create.body,
    draft: true,
    state: 'open',
    merged_at: null,
    head: { ref: 'feature', sha: expected.head_sha, repo: repository },
    base: { ref: 'dev', sha: 'b'.repeat(40), repo: repository },
  };
  const comments: { id: number; body: string; html_url: string; issue_url: string }[] = [];
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const state = {
    exists: true,
    duplicatePr: false,
    lose: false,
    refuseReady: false,
    mismatch: false,
    moved: false,
    missing: false,
    wrongIssueKind: false,
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const body =
        request.method === 'GET' ? {} : ((await request.json()) as Record<string, unknown>);
      requests.push({ method: request.method, path: url.pathname, body });
      expect(request.headers.get('Authorization')).toBe('Bearer fixture-secret');
      if (state.missing) return new Response('', { status: 404 });
      let result: unknown;
      if (url.pathname.endsWith('/branches/feature'))
        result = { name: 'feature', commit: { sha: pr.head.sha } };
      else if (url.pathname.endsWith('/pulls')) {
        if (request.method === 'POST') {
          state.exists = true;
          result = pr;
        } else result = state.exists ? (state.duplicatePr ? [pr, pr] : [pr]) : [];
      } else if (url.pathname.endsWith('/pulls/42')) {
        if (request.method === 'PATCH' && !state.mismatch) pr.body = String(body.body);
        if (state.moved) pr.head.sha = 'c'.repeat(40);
        result = pr;
      } else if (url.pathname === '/graphql') {
        expect(body.query).toContain('markPullRequestReadyForReview');
        expect(body.variables).toEqual({ id: 'PR_node' });
        if (!state.refuseReady) pr.draft = false;
        result = { data: { markPullRequestReadyForReview: { pullRequest: { id: 'PR_node' } } } };
      } else if (url.pathname.endsWith('/issues/42'))
        result = {
          number: 42,
          html_url: 'https://github.com/owner/repo/issues/42',
          title: 'Issue',
          body: null,
          state: 'open',
          ...(state.wrongIssueKind ? { pull_request: {} } : {}),
        };
      else if (url.pathname.includes('/comments')) {
        if (request.method === 'POST')
          comments.push({
            id: comments.length + 1,
            body: String(body.body),
            html_url: `https://github.com/owner/repo/pull/42#issuecomment-${String(comments.length + 1)}`,
            issue_url: 'https://api.github.com/repos/owner/repo/issues/42',
          });
        if (request.method === 'PATCH' && !state.mismatch)
          comments.find(c => String(c.id) === url.pathname.split('/').at(-1))!.body = String(
            body.body
          );
        const page = Number(url.searchParams.get('page') ?? 1);
        result =
          request.method === 'GET'
            ? comments.slice((page - 1) * 100, page * 100)
            : request.method === 'POST'
              ? comments.at(-1)
              : comments.find(c => String(c.id) === url.pathname.split('/').at(-1));
      } else if (url.pathname.endsWith('/check-runs'))
        result = {
          total_count: 1,
          check_runs: [
            {
              id: 1,
              name: 'test',
              head_sha: pr.head.sha,
              status: 'completed',
              conclusion: 'success',
              check_suite: { id: 1 },
              app: { id: 1 },
            },
          ],
        };
      else if (url.pathname.endsWith('/statuses')) result = [];
      else return new Response('', { status: 404 });
      if (state.lose && request.method !== 'GET') {
        state.lose = false;
        return new Response('response lost', { status: 502 });
      }
      return Response.json(result);
    },
  });
  const dispatcher = new ForgeDispatcher([createGitHubPlugin({ apiBase: server.url.origin })], {
    cwd: process.cwd(),
    env: { GH_TOKEN: 'fixture-secret' },
    discoverHome: async () => [],
    discoverPath: async () => [],
  });
  return {
    pr,
    comments,
    requests,
    state,
    server,
    dispatch: (request: PublicRequest) => dispatcher.publicOperation(request),
  };
}

async function packFixture(publication = false, base = 'dev') {
  const f = fixture();
  const temp = track(await mkdtemp(join(tmpdir(), 'forge pack nodes ')));
  let root = join(temp, 'source');
  const home = join(temp, 'home');
  const artifacts = join(temp, 'artifacts');
  await mkdir(home);
  await mkdir(join(artifacts, 'review'), { recursive: true });
  await writeFile(join(home, 'forge.json'), JSON.stringify({ hosts: {} }));
  await exec('git', ['init', '-q', '-b', publication ? 'fixture-source' : 'feature', root]);
  const imported = Bun.spawn(['git', '-C', root, 'fast-import', '--quiet'], {
    stdin: new Blob([
      `commit refs/heads/${base}
mark :1
committer Fixture <fixture@example.test> 1700000000 +0000
data 7
fixture
M 100644 inline work.txt
data 5
base

commit refs/heads/feature
committer Fixture <fixture@example.test> 1700000001 +0000
data 6
change
from :1
M 100644 inline work.txt
data 7
change

done
`,
    ]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const importError = await new Response(imported.stderr).text();
  expect(await imported.exited, importError).toBe(0);
  const sha = (await readFile(join(root, '.git/refs/heads/feature'), 'utf8')).trim();
  const baseSha = (await readFile(join(root, `.git/refs/heads/${base}`), 'utf8')).trim();
  const remote = join(temp, 'remote.git');
  if (publication) {
    await exec('git', ['init', '--bare', '-q', remote]);
    await exec('git', ['push', remote, `refs/heads/${base}`], { cwd: root });
    await appendFile(
      join(root, '.git/config'),
      `
[remote "origin"]
url = ${remote.replaceAll('\\', '/')}
pushurl = ${remote.replaceAll('\\', '/')}
fetch = +refs/heads/*:refs/remotes/origin/*
`
    );
    const checkout = join(temp, 'checkout');
    await exec('git', ['worktree', 'add', checkout, 'feature'], { cwd: root });
    root = checkout;
  }
  f.pr.head.sha = sha;
  f.pr.base.ref = base;
  const pr = prRecordSchema.parse({
    ref,
    ...expected,
    base,
    head_sha: sha,
    url: f.pr.html_url,
    is_draft: true,
    state: 'open',
    title: 'Fixture',
    body: 'Fixture',
  });
  const env = {
    ...process.env,
    GH_TOKEN: 'fixture-secret',
    GITHUB_TOKEN: '',
    ARCHON_HOME: home,
    ARTIFACTS_DIR: artifacts,
    ARCHON_EXECUTABLE: process.execPath,
    ARCHON_EXECUTABLE_ARGS: JSON.stringify([
      join(
        import.meta.dir,
        publication
          ? '../../../cli/src/commands/fixtures/publisher-forge-cli.ts'
          : '../../../cli/src/commands/fixtures/forge-public-cli.ts'
      ),
      f.server.url.origin,
      ...(publication ? [JSON.stringify(repo)] : []),
    ]),
    INPUTS_PR: JSON.stringify(pr),
  };
  const pack = join(import.meta.dir, '../../../../.archon/workflows/sdlc');
  return { f, root, remote, sha, baseSha, pr, env, artifacts, pack };
}

describe('public GitHub operations through the owning boundary', () => {
  it('reuses the exact branch PR with its existing content and draft state', async () => {
    const f = fixture();
    try {
      f.pr.draft = false;
      f.pr.title = 'Existing title';
      f.pr.body = 'Existing body';
      expect(await f.dispatch(create)).toMatchObject({
        kind: 'ok',
        value: {
          ref,
          base: 'dev',
          is_draft: false,
          title: 'Existing title',
          body: 'Existing body',
        },
      });
      expect(f.requests.every(r => r.method === 'GET')).toBe(true);
      expect(await f.dispatch({ ...create, base: 'main' })).toMatchObject({
        kind: 'error',
        error: { kind: 'verify_failed' },
      });
      expect(f.requests.every(r => r.method === 'GET')).toBe(true);
    } finally {
      f.server.stop(true);
    }
  });
  it.each(['title', 'body', 'draft'] as const)(
    'still verifies %s on a newly created PR',
    async field => {
      const f = fixture();
      try {
        f.state.exists = false;
        if (field === 'draft') f.pr.draft = false;
        else f.pr[field] = 'Unexpected content';
        expect(await f.dispatch(create)).toMatchObject({
          kind: 'error',
          error: { kind: 'verify_failed', observed: 'PR content or draft mismatch' },
        });
        expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      } finally {
        f.server.stop(true);
      }
    }
  );
  it.each(['pr-42-review', 'archon/pr-42-review'])(
    'refuses synthetic branch %s in the actual publisher before any push or public write',
    async branch => {
      const { f, root, remote, env, pack } = await packFixture(true);
      try {
        await exec('git', ['branch', '-m', branch], { cwd: root });
        await expect(
          exec('uv', ['run', 'python', join(pack, 'pr/scripts/publish-pr.py')], {
            cwd: root,
            env: {
              ...env,
              INPUTS_CONTENT: JSON.stringify({
                title: create.title,
                body: create.body,
                base: 'dev',
              }),
              INPUTS_DRAFT: 'true',
            },
          })
        ).rejects.toThrow('synthetic fork-review branch');
        expect(
          (
            await exec('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname)'])
          ).stdout.trim()
        ).toBe('refs/heads/dev');
        expect(f.requests).toHaveLength(0);
      } finally {
        f.server.stop(true);
      }
    }
  );

  it('creates with an explicitly qualified fork head without changing the base repository', async () => {
    const f = fixture();
    try {
      f.state.exists = false;
      f.pr.head.repo = { full_name: 'fork/repo', html_url: 'https://github.com/fork/repo' };
      expect(
        await f.dispatch({ ...create, head_repo: { ...repo, path: 'fork/repo' } })
      ).toMatchObject({ kind: 'ok', value: { ref, head_repo: { ...repo, path: 'fork/repo' } } });
      expect(f.requests.find(r => r.method === 'POST')).toMatchObject({
        path: '/repos/owner/repo/pulls',
        body: { head: 'fork:feature', base: 'dev' },
      });
    } finally {
      f.server.stop(true);
    }
  });
  it('refuses incomplete comment pagination before any public write', async () => {
    const f = fixture();
    try {
      for (let id = 1; id <= 10000; id++)
        f.comments.push({
          id,
          body: 'ordinary',
          html_url: `https://github.com/owner/repo/pull/42#issuecomment-${String(id)}`,
          issue_url: 'https://api.github.com/repos/owner/repo/issues/42',
        });
      expect(
        await f.dispatch({
          op: 'comment.upsert',
          target: { kind: 'pr', ref, expected },
          marker: '<!-- report -->',
          body: 'report',
        })
      ).toMatchObject({ kind: 'error', error: { kind: 'invalid_response' } });
      expect(f.requests.every(r => r.method === 'GET')).toBe(true);
    } finally {
      f.server.stop(true);
    }
  });
  it('reconciles an accepted new marker comment after response loss and refuses a mismatched edit read-back', async () => {
    const f = fixture();
    const request: PublicRequest = {
      op: 'comment.upsert',
      target: { kind: 'pr', ref, expected },
      marker: '<!-- report -->',
      body: 'report',
    };
    try {
      f.state.lose = true;
      expect(await f.dispatch(request)).toMatchObject({
        kind: 'error',
        error: { kind: 'verify_failed' },
      });
      expect(await f.dispatch(request)).toMatchObject({ kind: 'ok', value: { id: 1 } });
      expect(f.comments).toHaveLength(1);
      f.state.mismatch = true;
      expect(await f.dispatch({ ...request, body: 'changed' })).toMatchObject({
        kind: 'error',
        error: { kind: 'verify_failed' },
      });
    } finally {
      f.server.stop(true);
    }
  });
  it('creates once after accepted response loss, and edits once after accepted response loss', async () => {
    const f = fixture();
    try {
      f.state.exists = false;
      f.state.lose = true;
      expect(await f.dispatch(create)).toMatchObject({
        kind: 'error',
        error: { kind: 'verify_failed', leave_behind: expect.any(String) },
      });
      expect(await f.dispatch(create)).toMatchObject({
        kind: 'ok',
        value: { ref, head_sha: expected.head_sha },
      });
      expect(f.requests.filter(r => r.method === 'POST')).toHaveLength(1);
      f.state.lose = true;
      const edit: PublicRequest = { op: 'pr.edit-body', ref, expected, body: 'new body' };
      expect(await f.dispatch(edit)).toMatchObject({
        kind: 'error',
        error: { kind: 'verify_failed' },
      });
      expect(await f.dispatch(edit)).toMatchObject({ kind: 'ok', value: { body: 'new body' } });
      expect(f.requests.filter(r => r.method === 'PATCH')).toHaveLength(1);
    } finally {
      f.server.stop(true);
    }
  });
  it.each(['wrong-repo', 'moved', 'ambiguous', 'missing'] as const)(
    'refuses %s before writes',
    async mode => {
      const f = fixture();
      try {
        if (mode === 'wrong-repo')
          f.pr.base.repo = { full_name: 'other/repo', html_url: 'https://github.com/other/repo' };
        if (mode === 'moved') f.state.moved = true;
        if (mode === 'ambiguous') f.state.duplicatePr = true;
        if (mode === 'missing') f.state.missing = true;
        const result = await f.dispatch(
          mode === 'ambiguous' ? create : { op: 'pr.ready', ref, expected }
        );
        expect(result.kind).toBe('error');
        expect(f.requests.every(r => r.method === 'GET')).toBe(true);
      } finally {
        f.server.stop(true);
      }
    }
  );
  it('refuses a successful GraphQL response that leaves the PR draft and an ignored body edit', async () => {
    const f = fixture();
    try {
      f.state.refuseReady = true;
      expect(await f.dispatch({ op: 'pr.ready', ref, expected })).toMatchObject({
        kind: 'error',
        error: { kind: 'verify_failed', observed: 'PR remains draft' },
      });
      f.state.mismatch = true;
      expect(
        await f.dispatch({ op: 'pr.edit-body', ref, expected, body: 'changed' })
      ).toMatchObject({ kind: 'error', error: { kind: 'verify_failed' } });
    } finally {
      f.server.stop(true);
    }
  });
  it('updates a marker beyond page one, reconciles response loss, and refuses duplicate markers', async () => {
    const f = fixture();
    const marker = '<!-- archon-review-report -->';
    const request: PublicRequest = {
      op: 'comment.upsert',
      target: { kind: 'pr', ref, expected },
      marker,
      body: 'report',
    };
    try {
      for (let id = 1; id <= 101; id++)
        f.comments.push({
          id,
          body: id === 101 ? `${marker}\nold` : 'ordinary',
          html_url: `https://github.com/owner/repo/pull/42#issuecomment-${String(id)}`,
          issue_url: 'https://api.github.com/repos/owner/repo/issues/42',
        });
      f.state.lose = true;
      expect(await f.dispatch(request)).toMatchObject({
        kind: 'error',
        error: { kind: 'verify_failed' },
      });
      expect(await f.dispatch(request)).toMatchObject({ kind: 'ok', value: { id: 101 } });
      expect(f.comments).toHaveLength(101);
      expect(f.requests.filter(r => r.method === 'PATCH')).toHaveLength(1);
      f.comments[0].body = marker;
      expect(await f.dispatch(request)).toMatchObject({
        kind: 'error',
        error: { kind: 'verify_failed' },
      });
    } finally {
      f.server.stop(true);
    }
  });
  it('distinguishes work items from PRs at the shared issues endpoint', async () => {
    const f = fixture();
    try {
      expect(await f.dispatch({ op: 'workitem.view', ref })).toMatchObject({
        kind: 'ok',
        value: { ref, body: '' },
      });
      f.state.wrongIssueKind = true;
      expect(
        await f.dispatch({
          op: 'comment.upsert',
          target: { kind: 'workitem', ref },
          marker: '<!-- report -->',
          body: 'report',
        })
      ).toMatchObject({ kind: 'error', error: { kind: 'verify_failed' } });
      expect(f.requests.every(r => r.method === 'GET')).toBe(true);
    } finally {
      f.server.stop(true);
    }
  });
  it.each(['inline', 'stdin', 'file', 'file-stdin'] as const)(
    'executes the public CLI with %s requests and audited, secret-free output',
    async source => {
      const f = fixture();
      const home = track(await mkdtemp(join(tmpdir(), 'forge public cli ')));
      await writeFile(join(home, 'forge.json'), JSON.stringify({ hosts: {} }));
      const request = JSON.stringify({ ref, expected });
      const requestFile = join(home, 'public request.json');
      await writeFile(requestFile, request);
      try {
        const processResult = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, '../../../cli/src/commands/fixtures/forge-public-cli.ts'),
            f.server.url.origin,
            'pr',
            'ready',
            source.startsWith('file') ? '--request-file' : '--request',
            source === 'file' ? requestFile : source === 'inline' ? request : '-',
            '--json',
            '--config',
            join(home, 'forge.json'),
          ],
          {
            stdin: new Blob([request]),
            stdout: 'pipe',
            stderr: 'pipe',
            env: {
              ...process.env,
              GH_TOKEN: 'fixture-secret',
              GITHUB_TOKEN: '',
              ARCHON_HOME: home,
            },
          }
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(processResult.stdout).text(),
          new Response(processResult.stderr).text(),
          processResult.exited,
        ]);
        expect(code).toBe(0);
        expect(prRecordSchema.parse(JSON.parse(stdout)).is_draft).toBe(false);
        expect(stderr).toContain('"op":"pr.ready"');
        expect(stdout + stderr).not.toContain('fixture-secret');
      } finally {
        f.server.stop(true);
      }
    }
  );
  it('executes the actual delivery and canonical-comment script nodes against the GitHub transport', async () => {
    const { f, root, pr, env, artifacts, pack } = await packFixture();
    try {
      const edit = await exec('uv', ['run', 'python', join(pack, 'deliver/scripts/public-pr.py')], {
        cwd: root,
        env: { ...env, INPUTS_OPERATION: 'edit-body', INPUTS_BODY: 'Literal $(data) `text`' },
      });
      expect(JSON.parse(edit.stdout).body).toBe('Literal $(data) `text`');
      await writeFile(join(artifacts, 'review/publication-target.json'), JSON.stringify(pr));
      await writeFile(
        join(artifacts, 'review/public-report.md'),
        'Public finding at src/file.ts:1'
      );
      const verdict = { ready: true, action: 'none', findings_summary: 'local report' };
      for (let round = 0; round < 2; round++) {
        const result = await exec(
          'uv',
          ['run', 'python', join(pack, 'review/scripts/publish-review.py')],
          { cwd: root, env: { ...env, INPUTS_VERDICT: JSON.stringify(verdict) } }
        );
        expect(JSON.parse(result.stdout)).toEqual(verdict);
      }
      expect(f.comments).toHaveLength(1);
      expect(f.comments[0].body).not.toContain(artifacts);
      f.state.moved = true;
      await expect(
        exec('uv', ['run', 'python', join(pack, 'deliver/scripts/public-pr.py')], {
          cwd: root,
          env: { ...env, INPUTS_OPERATION: 'edit-body', INPUTS_BODY: 'refused' },
        })
      ).rejects.toThrow();
      expect(f.pr.body).toBe('Literal $(data) `text`');
    } finally {
      f.server.stop(true);
    }
  });
  describe('publisher base resolution', () => {
    const base = 'integration/runtime';
    for (const mode of [
      'local',
      'remote-only',
      'unfetched',
      'stale-local',
      'stale-remote',
      'ambiguous-tag',
    ]) {
      describe(`${mode} base`, () => {
        let publication: Awaited<ReturnType<typeof packFixture>>;
        let baseSha: string;
        beforeEach(async () => {
          publication = await packFixture(true, base);
          const { f, root, sha } = publication;
          f.state.exists = false;
          baseSha = publication.baseSha;
          if (mode === 'remote-only') await exec('git', ['fetch', 'origin'], { cwd: root });
          if (mode === 'remote-only' || mode === 'unfetched') {
            await exec('git', ['branch', '-D', base], { cwd: root });
          }
          if (mode === 'stale-local') await exec('git', ['branch', '-f', base, sha], { cwd: root });
          if (mode === 'stale-remote')
            await exec('git', ['update-ref', `refs/remotes/origin/${base}`, sha], { cwd: root });
          if (mode === 'ambiguous-tag') await exec('git', ['tag', base, sha], { cwd: root });
        });
        it('publishes the exact branch SHA through the actual script node', async () => {
          const { f, root, remote, sha, env, pack, artifacts } = publication;
          try {
            const trace = join(artifacts, 'publisher-git.log');
            const published = await exec(
              'uv',
              ['run', 'python', join(pack, 'pr/scripts/publish-pr.py')],
              {
                cwd: root,
                env: {
                  ...env,
                  GIT_TRACE: trace,
                  INPUTS_CONTENT: JSON.stringify({ title: create.title, body: create.body, base }),
                  INPUTS_DRAFT: 'true',
                },
              }
            );
            expect(prRecordSchema.parse(JSON.parse(published.stdout))).toMatchObject({
              ref,
              head_repo: repo,
              head: 'feature',
              base,
              head_sha: sha,
            });
            expect(f.requests.filter(r => r.method === 'POST')).toEqual([
              {
                method: 'POST',
                path: '/repos/owner/repo/pulls',
                body: {
                  title: create.title,
                  body: create.body,
                  base,
                  head: 'owner:feature',
                  head_repo: 'repo',
                  draft: true,
                },
              },
            ]);
            const commands = await readFile(trace, 'utf8');
            expect(commands).toContain(
              `git fetch --no-tags --no-write-fetch-head origin +refs/heads/${base}:refs/remotes/origin/${base}`
            );
            expect(commands).toContain(`git rev-list --count ${baseSha}..${sha} --`);
            const localRefs = (
              await exec('git', ['for-each-ref', '--format=%(refname) %(objectname) %(HEAD)'], {
                cwd: root,
              })
            ).stdout;
            const remoteRefs = (
              await exec('git', [
                '--git-dir',
                remote,
                'for-each-ref',
                '--format=%(refname) %(objectname)',
              ])
            ).stdout;
            expect(localRefs).toContain(`refs/heads/feature ${sha} *`);
            expect(localRefs).toContain(`refs/remotes/origin/${base} ${baseSha}`);
            expect(remoteRefs.trim().split(/\r?\n/)).toEqual([
              `refs/heads/feature ${sha}`,
              `refs/heads/${base} ${baseSha}`,
            ]);
            if (mode === 'remote-only' || mode === 'unfetched')
              expect(localRefs).not.toContain(`refs/heads/${base} `);
            else
              expect(localRefs).toContain(
                `refs/heads/${base} ${mode === 'stale-local' ? sha : baseSha}`
              );
          } finally {
            f.server.stop(true);
          }
        });
      });
    }
  });
  describe('publisher refusals and adoption', () => {
    let publication: Awaited<ReturnType<typeof packFixture>>;
    beforeEach(async () => {
      publication = await packFixture(true);
    });
    it.each([
      ['missing', 'missing-base', 'fetch'],
      ['missing-remote', 'dev', 'fetch'],
      ['no-commits', 'dev', 'commits ahead'],
      ['same-branch', 'feature', 'distinct from the base'],
      ['detached', 'dev', 'named branch'],
      ['shorthand', '@{-1}', 'literal base branch'],
      ['unsafe', '--upload-pack=unexpected', 'base'],
      ['unsafe', 'dev:refs/heads/other', 'check-ref-format'],
      ['unsafe', '@{-1}', 'check-ref-format'],
      ['unsafe', 'refs/heads/dev', 'base'],
      ['unsafe', 'dev\n$(touch injected)', 'check-ref-format'],
      ['dirty', 'dev', 'clean checkout'],
      ['dirty-tracked', 'dev', 'clean checkout'],
      ['dirty-staged', 'dev', 'clean checkout'],
      ['moved-head', 'dev', 'checkout changed'],
    ])('refuses %s (%s) before pushing or creating', async (mode, base, diagnostic) => {
      const { f, root, remote, env, pack, artifacts } = publication;
      try {
        const baseSha = publication.baseSha;
        if (mode === 'missing-remote') {
          await exec('git', ['fetch', 'origin'], { cwd: root });
          await exec('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/dev']);
        }
        if (mode === 'detached') await exec('git', ['checkout', '--detach'], { cwd: root });
        if (mode === 'shorthand') {
          await exec('git', ['checkout', '-b', 'previous'], { cwd: root });
          await exec('git', ['checkout', 'feature'], { cwd: root });
        }
        if (mode === 'no-commits')
          await exec('git', ['push', 'origin', `${publication.sha}:refs/heads/dev`], { cwd: root });
        if (mode === 'dirty') await writeFile(join(root, 'uncommitted.txt'), 'Uncommitted work');
        if (mode === 'dirty-tracked' || mode === 'dirty-staged') {
          await writeFile(join(root, 'work.txt'), 'Uncommitted work');
          if (mode === 'dirty-staged') await exec('git', ['add', 'work.txt'], { cwd: root });
        }
        if (mode === 'moved-head') {
          // A real upload-pack changes the source while the publisher fetches.
          // No git operation or publisher guard is mocked.
          const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
          const upload = join(artifacts, 'move-head.sh');
          await writeFile(
            upload,
            `git -C ${quote(root.replaceAll('\\', '/'))} update-ref refs/heads/feature ${baseSha}\nexec git-upload-pack "$@"\n`
          );
          await exec(
            'git',
            ['config', 'remote.origin.uploadpack', `sh ${quote(upload.replaceAll('\\', '/'))}`],
            { cwd: root }
          );
        }
        await expect(
          exec('uv', ['run', 'python', join(pack, 'pr/scripts/publish-pr.py')], {
            cwd: root,
            env: {
              ...env,
              INPUTS_CONTENT: JSON.stringify({ title: create.title, body: create.body, base }),
              INPUTS_DRAFT: 'true',
            },
          })
        ).rejects.toThrow(diagnostic);
        expect(
          (
            await exec('git', [
              '--git-dir',
              remote,
              'for-each-ref',
              '--format=%(refname) %(objectname)',
            ])
          ).stdout.trim()
        ).toBe(
          mode === 'missing-remote'
            ? ''
            : `refs/heads/dev ${mode === 'no-commits' ? publication.sha : baseSha}`
        );
        expect(f.requests).toHaveLength(0);
        if (mode === 'moved-head')
          expect((await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()).toBe(
            baseSha
          );
      } finally {
        f.server.stop(true);
      }
    });

    it.each(['reuse', 'conflicting-base'])(
      'preserves an adopted PR through the actual publisher: %s',
      async mode => {
        const { f, root, sha, env, pack } = publication;
        try {
          f.pr.draft = false;
          f.pr.title = 'Existing title';
          f.pr.body = 'Existing body';
          const publish = (base: string) =>
            exec('uv', ['run', 'python', join(pack, 'pr/scripts/publish-pr.py')], {
              cwd: root,
              env: {
                ...env,
                INPUTS_CONTENT: JSON.stringify({ title: create.title, body: create.body, base }),
                INPUTS_DRAFT: 'true',
              },
            });
          if (mode === 'reuse')
            expect(prRecordSchema.parse(JSON.parse((await publish('dev')).stdout))).toMatchObject({
              ref,
              head_repo: repo,
              head: 'feature',
              head_sha: sha,
              base: 'dev',
              is_draft: false,
              title: 'Existing title',
              body: 'Existing body',
            });
          else {
            await exec('git', ['push', 'origin', 'refs/heads/dev:refs/heads/other-base'], {
              cwd: root,
            });
            await expect(publish('other-base')).rejects.toThrow('PR identity or head changed');
          }
          expect(f.requests.every(r => r.method === 'GET')).toBe(true);
          expect(f.pr.base.ref).toBe('dev');
        } finally {
          f.server.stop(true);
        }
      }
    );
  });

  it('checks and flips ready through the actual script node', async () => {
    const { f, root, pr, env, pack } = await packFixture();
    try {
      const ready = await exec(
        'uv',
        ['run', 'python', join(pack, 'deliver/scripts/public-pr.py')],
        { cwd: root, env: { ...env, INPUTS_OPERATION: 'ready', INPUTS_BODY: '' } }
      );
      expect(ready.stdout.trim()).toBe(pr.url);
      expect(f.pr.draft).toBe(false);
    } finally {
      f.server.stop(true);
    }
  });
});
