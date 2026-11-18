/**
 * `attachment.put` on GitHub: an image stored in the repository, so a comment can
 * embed it.
 *
 * GitHub's API takes no image upload into a comment, so the file is committed to
 * the orphan branch `archon-attachments` of the target repository. Its tree holds
 * only attachments, so a push to it runs no workflow, and the file is exactly as
 * visible as the repository. The link is pinned to the commit that holds the file,
 * so a later push to the branch cannot change what it shows. Nothing prunes the
 * branch; deleting it breaks the links into it.
 *
 * The blob, tree and commit are unreachable until the branch moves, so the ref
 * update is the one write that decides the outcome.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ForgeMutationRequest, ForgeResponse } from '@archon/forge/operations';
import { githubRequest, githubResponseError, githubSend, location, type Fetch } from './api';
import { applied, refused, unverified, type Submit } from './mutation-outcome';

type PutRequest = Extract<ForgeMutationRequest, { op: 'attachment.put' }>;

const BRANCH = 'archon-attachments';
/** Ref writes that find the branch moved by another writer, before the put is refused. */
const REF_ATTEMPTS = 3;

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
  const name = `${digest}.${extensions[request.contentType]}`;
  const result = (changed: boolean, commit: string) =>
    applied(request, {
      changed,
      attachment: {
        url: `${repository.html_url}/blob/${commit}/${name}?raw=true`,
        digest,
        bytes: bytes.byteLength,
        contentType: request.contentType,
      },
    });

  for (let attempt = 1; attempt <= REF_ATTEMPTS; attempt++) {
    const parent = await readBranch(fetchImpl, token, api);
    if (parent?.names.has(name)) return result(false, parent.commit);
    const blob = await create(fetchImpl, token, `${api}/git/blobs`, {
      content: request.content,
      encoding: 'base64',
    });
    const tree = await create(fetchImpl, token, `${api}/git/trees`, {
      ...(parent ? { base_tree: parent.tree } : {}),
      tree: [{ path: name, mode: '100644', type: 'blob', sha: blob }],
    });
    const commit = await create(fetchImpl, token, `${api}/git/commits`, {
      message: `Add attachment ${name}`,
      tree,
      parents: parent ? [parent.commit] : [],
    });
    submit('submitted');
    const response = await githubSend(
      fetchImpl,
      token,
      parent ? `${api}/git/refs/heads/${BRANCH}` : `${api}/git/refs`,
      parent
        ? { method: 'PATCH', body: JSON.stringify({ sha: commit, force: false }) }
        : { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit }) }
    );
    // 422 is GitHub refusing the move: the branch was created or advanced by another
    // writer since it was read. Nothing referenced the new commit, so read again.
    if (response.status === 422) continue;
    if (!response.ok) throw githubResponseError(response);
    submit('acknowledged');
    // The ref write answers with where the branch now points, which is the read-back.
    const moved = refSchema.safeParse(await response.json().catch(() => null));
    if (!moved.success || moved.data.object.sha !== commit)
      return unverified(
        request,
        'The attachment branch did not answer with the new commit',
        `branch ${BRANCH} may point at commit ${commit}`
      );
    return result(true, commit);
  }
  return refused(request, {
    kind: 'conflict',
    message: `branch ${BRANCH} kept moving; the attachment was not stored`,
  });
}
