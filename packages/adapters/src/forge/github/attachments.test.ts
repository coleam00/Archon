import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { forgeResponseSchema, type ForgeRequest } from '@archon/forge/operations';
import { json } from './lifecycle-fixture';
import { handleGithubOperation } from './operations';

const repo = { host: 'github.com', path: 'archon/test' };
const API = 'https://api.github.com/repos/archon/test';
const content = Buffer.from('not really a png').toString('base64');
const name = `${createHash('sha256').update(Buffer.from(content, 'base64')).digest('hex')}.png`;

/**
 * A GitHub repository's git data API, holding commits and the one attachments
 * branch. `moveOnce` lets another writer create or advance the branch, adding
 * `other.png`, just before the first ref write lands, so that write is refused with 422.
 */
function gitGitHub(options: { push?: boolean; moveOnce?: boolean } = {}) {
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const trees = new Map<string, string[]>();
  let branch: string | null = null;
  let moveOnce = options.moveOnce ?? false;
  let next = 0;
  const id = (kind: string) => `${kind}${String(++next)}`;
  const writes: string[] = [];
  const commitOf = (tree: string[], parents: string[]) => {
    const treeSha = id('tree');
    trees.set(treeSha, tree);
    const sha = id('commit');
    commits.set(sha, { tree: treeSha, parents });
    return sha;
  };
  const read = (url: string): Response => {
    if (url === API)
      return json({
        html_url: 'https://github.com/archon/test',
        permissions: { push: options.push ?? true },
      });
    if (url === `${API}/git/ref/heads/archon-attachments`)
      return branch ? json({ object: { sha: branch } }) : json({ message: 'Not Found' }, 404);
    const commit = /\/git\/commits\/(\w+)$/.exec(url);
    if (commit) return json({ sha: commit[1], tree: { sha: commits.get(commit[1])?.tree } });
    const tree = /\/git\/trees\/(\w+)$/.exec(url);
    if (tree) return json({ tree: (trees.get(tree[1]) ?? []).map(path => ({ path })) });
    return json({ message: `unexpected GET ${url}` }, 404);
  };
  const moveRef = (method: string, sha: string): Response => {
    if (moveOnce) {
      moveOnce = false;
      branch = commitOf(['other.png'], branch ? [branch] : []);
      return json({ message: 'Reference already exists' }, 422);
    }
    if (method === 'POST' ? branch !== null : commits.get(sha)?.parents[0] !== branch)
      return json({ message: 'Update is not a fast forward' }, 422);
    branch = sha;
    return json({ ref: 'refs/heads/archon-attachments', object: { sha } }, 201);
  };
  const write = (url: string, method: string, body: Record<string, unknown>): Response => {
    writes.push(`${method} ${url.slice(API.length)}`);
    if (url === `${API}/git/blobs`) return json({ sha: id('blob') }, 201);
    if (url === `${API}/git/trees`) {
      const base = typeof body.base_tree === 'string' ? (trees.get(body.base_tree) ?? []) : [];
      const sha = id('tree');
      trees.set(sha, [...base, ...(body.tree as { path: string }[]).map(entry => entry.path)]);
      return json({ sha }, 201);
    }
    if (url === `${API}/git/commits`) {
      const sha = id('commit');
      commits.set(sha, { tree: String(body.tree), parents: body.parents as string[] });
      return json({ sha }, 201);
    }
    return moveRef(method, String(body.sha));
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return read(String(input));
    return write(String(input), method, JSON.parse(String(init?.body)) as Record<string, unknown>);
  }) as typeof globalThis.fetch;
  return { fetch, writes, commits, trees, branch: () => branch };
}

const put = {
  operationId: 'attach-1',
  op: 'attachment.put',
  repo,
  contentType: 'image/png',
  content,
} satisfies ForgeRequest;

async function run(github: { fetch: typeof globalThis.fetch }) {
  return forgeResponseSchema.parse(
    await handleGithubOperation(put, { token: 'token', fetch: github.fetch })
  );
}

describe('attachment.put', () => {
  test('the first put creates the branch with a parentless commit and links the file at it', async () => {
    const github = gitGitHub();
    const response = await run(github);
    const head = github.branch();
    expect(head).not.toBeNull();
    expect(github.commits.get(head ?? '')?.parents).toEqual([]);
    expect(response).toMatchObject({
      ok: true,
      result: {
        op: 'attachment.put',
        value: {
          target: repo,
          outcome: 'applied',
          changed: true,
          attachment: {
            url: `https://github.com/archon/test/blob/${head ?? ''}/${name}?raw=true`,
            digest: name.slice(0, -'.png'.length),
            bytes: Buffer.from(content, 'base64').byteLength,
            contentType: 'image/png',
          },
        },
      },
    });
    expect(github.writes.at(-1)).toBe('POST /git/refs');
  });

  test('the same bytes again write nothing and link the commit that holds them', async () => {
    const github = gitGitHub();
    await run(github);
    const head = github.branch();
    const writes = github.writes.length;
    const response = await run(github);
    expect(github.writes.length).toBe(writes);
    expect(response).toMatchObject({
      ok: true,
      result: {
        value: {
          changed: false,
          attachment: { url: `https://github.com/archon/test/blob/${head ?? ''}/${name}?raw=true` },
        },
      },
    });
  });

  test('a token that cannot push is refused before anything is written', async () => {
    const github = gitGitHub({ push: false });
    expect(await run(github)).toMatchObject({
      ok: false,
      error: { kind: 'authorization' },
      mutation: { op: 'attachment.put', outcome: 'refused' },
    });
    expect(github.writes).toEqual([]);
  });

  test('a refused ref write is reported as GitHub refused it, with its status, and not tried again', async () => {
    const github = gitGitHub({ moveOnce: true });
    expect(await run(github)).toMatchObject({
      ok: false,
      error: { kind: 'conflict', status: 422 },
      mutation: { op: 'attachment.put', outcome: 'refused' },
    });
    expect(github.writes.filter(write => write.includes('/git/refs'))).toEqual(['POST /git/refs']);
  });

  test('a put on a branch with other files extends it and keeps them', async () => {
    const github = gitGitHub({ moveOnce: true });
    await run(github);
    const response = await run(github);
    if (!response.ok || response.result.op !== 'attachment.put')
      throw new Error(JSON.stringify(response));
    const head = github.branch() ?? '';
    expect(response.result.value.attachment.url).toContain(`/blob/${head}/`);
    expect(github.writes.at(-1)).toBe('PATCH /git/refs/heads/archon-attachments');
    const stored = github.commits.get(head);
    expect(stored?.parents.length).toBe(1);
    expect(github.trees.get(stored?.tree ?? '')).toEqual(['other.png', name]);
  });
});
