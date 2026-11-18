/**
 * `attachment.put` on GitHub: an image stored in the repository, so a comment can
 * embed it.
 *
 * GitHub's API takes no image upload into a comment, so the file is committed to
 * the orphan branch `archon-attachments` of the target repository. Its tree holds
 * only attachments, so a push to it runs no workflow, and the file is exactly as
 * visible as the repository. The link is pinned to the commit that holds the file,
 * so a later push to the branch cannot change what it shows. Nothing prunes the
 * branch, and deleting it does not guarantee the commit-addressed links stop
 * serving the file.
 *
 * The blob, tree and commit are unreachable until the branch moves, so the ref
 * update is the one write that decides the outcome. A refused ref write, such as
 * a 422 when another writer moved the branch first, is reported as GitHub's own
 * refusal with its status; a caller sends the same bytes again, which is safe.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ForgeMutationRequest, ForgeResponse } from '@archon/forge/operations';
import { githubRequest, githubResponseError, githubSend, location, type Fetch } from './api';
import { applied, refused, unverified, type Submit } from './mutation-outcome';

type PutRequest = Extract<ForgeMutationRequest, { op: 'attachment.put' }>;

const BRANCH = 'archon-attachments';

const extensions = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
} satisfies Record<PutRequest['contentType'], string>;

const sha = z.string().min(1);
const repositorySchema = z.object({
  html_url: z.url(),
  // Absent for some tokens; the ref write then answers for the permission.
  permissions: z.object({ push: z.boolean() }).optional(),
});
const refSchema = z.object({ object: z.object({ sha }) });
const commitSchema = z.object({ sha, tree: z.object({ sha }) });
const treeSchema = z.object({ tree: z.array(z.object({ path: z.string() })) });
const objectSchema = z.object({ sha });

/** The branch's head commit and its tree, or null before the first attachment. */
async function readBranch(
  fetchImpl: Fetch,
  token: string,
  api: string
): Promise<{ commit: string; tree: string; names: Set<string> } | null> {
  const response = await githubSend(fetchImpl, token, `${api}/git/ref/heads/${BRANCH}`);
  if (response.status === 404) return null;
  if (!response.ok) throw githubResponseError(response);
  const head = refSchema.parse(await response.json()).object.sha;
  const commit = commitSchema.parse(
    await githubRequest(fetchImpl, token, `${api}/git/commits/${head}`)
  );
  const tree = treeSchema.parse(
    await githubRequest(fetchImpl, token, `${api}/git/trees/${commit.tree.sha}`)
  );
  return {
    commit: commit.sha,
    tree: commit.tree.sha,
    names: new Set(tree.tree.map(entry => entry.path)),
  };
}

async function create(
  fetchImpl: Fetch,
  token: string,
  url: string,
  body: Record<string, unknown>
): Promise<string> {
  return objectSchema.parse(
    await githubRequest(fetchImpl, token, url, { method: 'POST', body: JSON.stringify(body) })
  ).sha;
}

interface Stored {
  name: string;
  digest: string;
  bytes: number;
  htmlUrl: string;
}

function storedResult(request: PutRequest, stored: Stored, changed: boolean, commit: string) {
  return applied(request, {
    changed,
    attachment: {
      url: `${stored.htmlUrl}/blob/${commit}/${stored.name}?raw=true`,
      digest: stored.digest,
      bytes: stored.bytes,
      contentType: request.contentType,
    },
  });
}

/** One read of the branch and, when the file is not on it, one commit that adds it. */
async function store(
  request: PutRequest,
  stored: Stored,
  fetchImpl: Fetch,
  token: string,
  api: string,
  submit: Submit
): Promise<ForgeResponse> {
  const parent = await readBranch(fetchImpl, token, api);
  if (parent?.names.has(stored.name)) return storedResult(request, stored, false, parent.commit);
  const blob = await create(fetchImpl, token, `${api}/git/blobs`, {
    content: request.content,
    encoding: 'base64',
  });
  const tree = await create(fetchImpl, token, `${api}/git/trees`, {
    ...(parent ? { base_tree: parent.tree } : {}),
    tree: [{ path: stored.name, mode: '100644', type: 'blob', sha: blob }],
  });
  const commit = await create(fetchImpl, token, `${api}/git/commits`, {
    message: `Add attachment ${stored.name}`,
    tree,
    parents: parent ? [parent.commit] : [],
  });
  submit('submitted');
  const answer = await githubRequest(
    fetchImpl,
    token,
    parent ? `${api}/git/refs/heads/${BRANCH}` : `${api}/git/refs`,
    parent
      ? { method: 'PATCH', body: JSON.stringify({ sha: commit, force: false }) }
      : { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit }) },
    () => {
      submit('acknowledged');
    }
  );
  // The ref write answers with where the branch now points, which is the read-back.
  const moved = refSchema.safeParse(answer);
  if (!moved.success || moved.data.object.sha !== commit)
    return unverified(
      request,
      'The attachment branch did not answer with the new commit',
      `branch ${BRANCH} may point at commit ${commit}`
    );
  return storedResult(request, stored, true, commit);
}

export async function putAttachment(
  request: PutRequest,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const { root, path } = location(request.repo);
  const api = `${root}/repos/${path}`;
  const repository = repositorySchema.parse(await githubRequest(fetchImpl, token, api));
  if (repository.permissions?.push === false) {
    return refused(request, {
      kind: 'authorization',
      message: `the token cannot push to ${request.repo.path}; an attachment is stored in the repository the change is proposed to`,
    });
  }
  const bytes = Buffer.from(request.content, 'base64');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const stored = {
    name: `${digest}.${extensions[request.contentType]}`,
    digest,
    bytes: bytes.byteLength,
    htmlUrl: repository.html_url,
  };
  return store(request, stored, fetchImpl, token, api, submit);
}
