/** GitHub reads of a pull request's changed files and of one file's text at a commit. */

import { z } from 'zod';
import { prFileSchema, type ForgeRequest, type ForgeResponse } from '@archon/forge/operations';
import { GitHubError, githubPages, githubRequest, location, type Fetch } from './api';

const pullSchema = z.object({
  changed_files: z.number().int().nonnegative(),
  head: z.object({ sha: z.string().min(1) }),
});
const pullFileSchema = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().min(1).optional(),
  status: prFileSchema.shape.status,
  patch: z.string().optional(),
});
const contentsSchema = z.object({
  type: z.literal('file'),
  encoding: z.string(),
  content: z.string(),
});

export async function handleGithubPrFiles(
  request: Extract<ForgeRequest, { op: 'pr.files' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const { root, path } = location(request.ref.repo);
  const base = `${root}/repos/${path}/pulls/${String(request.ref.number)}`;
  const pull = pullSchema.parse(await githubRequest(fetchImpl, token, base));
  const expected = pull.changed_files;
  const rows = await githubPages(fetchImpl, token, `${base}/files`, value =>
    z.array(pullFileSchema).parse(value)
  );
  // GitHub stops listing a pull request's files at 3,000, so a shorter list is a
  // truncated one, not the pull request's change.
  if (rows.length !== expected) {
    throw new GitHubError({
      kind: 'forge_error',
      message: `GitHub listed ${String(rows.length)} of the ${String(expected)} files pull request ${String(request.ref.number)} changes`,
    });
  }
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: {
        ref: request.ref,
        head_revision: pull.head.sha,
        files: rows.map(row => ({
          path: row.filename,
          previous_path: row.previous_filename ?? null,
          status: row.status,
          patch: row.patch ?? null,
        })),
      },
    },
  };
}

export async function handleGithubRepoFile(
  request: Extract<ForgeRequest, { op: 'repo.file' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const { root, path } = location(request.repo);
  const file = request.path.split('/').map(encodeURIComponent).join('/');
  const raw = await githubRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/contents/${file}?ref=${encodeURIComponent(request.revision)}`
  );
  const at = `${request.path} at ${request.revision}`;
  const contents = contentsSchema.safeParse(raw);
  if (!contents.success)
    throw new GitHubError({ kind: 'not_found', message: `${at} is not a file` }, true);
  // Above 1 MB the contents API answers with no content rather than a truncated one.
  if (contents.data.encoding !== 'base64')
    throw new GitHubError({
      kind: 'forge_error',
      message: `${at} is larger than GitHub returns through its contents API`,
    });
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(contents.data.content, 'base64')
    );
  } catch {
    throw new GitHubError({ kind: 'forge_error', message: `${at} is not UTF-8 text` });
  }
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: { repo: request.repo, path: request.path, revision: request.revision, text },
    },
  };
}
