import { describe, expect, test } from 'bun:test';
import {
  forgeRequestSchema,
  forgeResponseSchema,
  type ForgeRequest,
} from '@archon/forge/operations';
import { handleGithubOperation } from './operations';

const repo = { host: 'github.com', path: 'archon/test' };
const ref = { repo, number: 7 };
const API = 'https://api.github.com/repos/archon/test';

/** A fake GitHub REST API answering by URL, recording every URL it was asked. */
function fakeGitHub(answer: (url: string) => unknown) {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    return Response.json(answer(url));
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

async function run(request: ForgeRequest, github: { fetch: typeof globalThis.fetch }) {
  return forgeResponseSchema.parse(
    await handleGithubOperation(request, { token: 'token', fetch: github.fetch })
  );
}

const changed = (index: number) => ({
  filename: `src/file-${String(index)}.ts`,
  status: 'modified',
  patch: `@@ -1 +1 @@ ${String(index)}`,
});

describe('pr.files', () => {
  const request = { operationId: 'files', op: 'pr.files', ref } satisfies ForgeRequest;

  test('reads every page, keeping renames and files with no patch', async () => {
    const github = fakeGitHub(url => {
      if (url === `${API}/pulls/7`) return { changed_files: 102, head: { sha: 'listed-head' } };
      if (url.endsWith('page=1')) return Array.from({ length: 100 }, (_, index) => changed(index));
      return [
        { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed' },
        { filename: 'logo.png', status: 'added' },
      ];
    });
    const response = await run(request, github);
    if (!response.ok || response.result.op !== 'pr.files')
      throw new Error(JSON.stringify(response));
    const { files, head_revision } = response.result.value;
    // The head comes from the pull request read that counted the files.
    expect(head_revision).toBe('listed-head');
    expect(files).toHaveLength(102);
    expect(files[0]).toEqual({
      path: 'src/file-0.ts',
      previous_path: null,
      status: 'modified',
      patch: '@@ -1 +1 @@ 0',
    });
    expect(files.slice(100)).toEqual([
      { path: 'src/new.ts', previous_path: 'src/old.ts', status: 'renamed', patch: null },
      { path: 'logo.png', previous_path: null, status: 'added', patch: null },
    ]);
    expect(github.urls.filter(url => url.includes('/files?'))).toHaveLength(2);
  });

  test('refuses a list read while the head moved, even when the count still matches', async () => {
    let reads = 0;
    const github = fakeGitHub(url => {
      if (url !== `${API}/pulls/7`) return [changed(1)];
      reads++;
      return { changed_files: 1, head: { sha: reads === 1 ? 'old-head' : 'new-head' } };
    });
    expect(await run(request, github)).toMatchObject({
      ok: false,
      error: { kind: 'forge_error', message: expect.stringContaining('new-head') },
    });
  });

  test('refuses a list GitHub cut short rather than returning part of the change', async () => {
    const github = fakeGitHub(url =>
      url === `${API}/pulls/7`
        ? { changed_files: 3001, head: { sha: 'listed-head' } }
        : [changed(1)]
    );
    expect(await run(request, github)).toMatchObject({
      ok: false,
      error: { kind: 'forge_error' },
    });
  });
});

describe('repo.file', () => {
  const revision = 'a'.repeat(40);
  const request = {
    operationId: 'file',
    op: 'repo.file',
    repo,
    path: 'src/__tests__/a b.test.ts',
    revision,
  } satisfies ForgeRequest;

  test('reads the text at the requested commit, not the default branch', async () => {
    const text = "describe('a', () => {});\n";
    const github = fakeGitHub(() => ({
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(text).toString('base64'),
    }));
    expect(await run(request, github)).toEqual({
      operationId: 'file',
      ok: true,
      result: { op: 'repo.file', value: { repo, path: request.path, revision, text } },
    });
    expect(github.urls).toEqual([`${API}/contents/src/__tests__/a%20b.test.ts?ref=${revision}`]);
  });

  test('refuses a file too large for the contents API instead of reading it as empty', async () => {
    const github = fakeGitHub(() => ({ type: 'file', encoding: 'none', content: '' }));
    expect(await run(request, github)).toMatchObject({
      ok: false,
      error: { kind: 'forge_error' },
    });
  });

  test('a path that is a directory is not found, and a malformed file answer is a forge error', async () => {
    expect(
      await run(
        request,
        fakeGitHub(() => [{ type: 'file', name: 'a.ts' }])
      )
    ).toMatchObject({
      ok: false,
      error: { kind: 'not_found' },
    });
    expect(
      await run(
        request,
        fakeGitHub(() => ({ type: 'file' }))
      )
    ).toMatchObject({
      ok: false,
      error: { kind: 'forge_error' },
    });
  });

  test('a path that would leave the contents endpoint is not a valid request', () => {
    for (const path of [
      '../../issues',
      'src/../../pulls',
      '/etc/passwd',
      'src//a.ts',
      'src/./a.ts',
    ])
      expect(forgeRequestSchema.safeParse({ ...request, path }).success).toBe(false);
  });
});
