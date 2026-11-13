/**
 * `checks.logs`: the log of one check unit.
 *
 * Only a GitHub Actions check run has a log, and its check-run id is its job id.
 * GitHub answers a job's log with a redirect to a short-lived signed URL. That URL
 * is itself a credential, so it is fetched without the token and never reaches an
 * error message.
 */

import { z } from 'zod';
import {
  CHECKS_LOGS_DEFAULT_BYTES,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import {
  GitHubError,
  githubRequest,
  githubResponseError,
  githubSend,
  location,
  type Fetch,
} from './api';

type LogsRequest = Extract<ForgeRequest, { op: 'checks.logs' }>;
type LogsValue = Extract<
  Extract<ForgeResponse, { ok: true }>['result'],
  { op: 'checks.logs' }
>['value'];
type CheckLog = LogsValue['log'];

const checkRunSchema = z.object({
  app: z.object({ slug: z.string().nullable().optional() }).nullable().optional(),
});

/**
 * The end of `bytes` within `cap`. When bytes before it were dropped, here or by
 * the caller (`cut`), it starts on a character rather than inside one.
 */
function utf8Tail(bytes: Buffer, cap: number, cut = false): Buffer {
  let start = Math.max(0, bytes.length - cap);
  if (start === 0 && !cut) return bytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start);
}

/** The last `cap` bytes of a body and its whole size, read without holding the whole. */
async function readTail(response: Response, cap: number): Promise<{ tail: Buffer; total: number }> {
  const kept: Uint8Array[] = [];
  let size = 0;
  let total = 0;
  const reader = response.body?.getReader();
  try {
    for (let read = await reader?.read(); read && !read.done; read = await reader?.read()) {
      kept.push(read.value);
      size += read.value.length;
      total += read.value.length;
      while (kept.length > 1 && size - kept[0].length >= cap) size -= kept.shift()?.length ?? 0;
    }
  } catch (cause) {
    throw new GitHubError(
      { kind: 'unavailable', message: 'GitHub log download was cut off' },
      false,
      {
        cause,
      }
    );
  }
  return { tail: utf8Tail(Buffer.concat(kept), cap, total > size), total };
}

/** The signed log URL's answer. Nothing about the URL is repeated in a failure. */
async function download(fetchImpl: Fetch, url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    throw new GitHubError({ kind: 'unavailable', message: 'GitHub log download failed' }, false, {
      cause,
    });
  }
  if (response.ok) return response;
  throw new GitHubError({
    kind: response.status >= 500 ? 'unavailable' : 'forge_error',
    message: `GitHub log download failed with HTTP ${String(response.status)}`,
    status: response.status,
  });
}

async function jobLog(
  fetchImpl: Fetch,
  token: string,
  url: string,
  cap: number
): Promise<CheckLog> {
  const answer = await githubSend(fetchImpl, token, url, { redirect: 'manual' });
  // A job still running has no log yet, and GitHub deletes a log when its retention ends.
  if (answer.status === 404 || answer.status === 410)
    return { kind: 'none', reason: 'log_unavailable' };
  const signed = answer.status === 302 ? answer.headers.get('location') : null;
  if (!signed && !answer.ok) throw githubResponseError(answer);
  const { tail, total } = await readTail(signed ? await download(fetchImpl, signed) : answer, cap);
  // Bytes that are not UTF-8 decode to a longer replacement character, so the
  // decoded text is held to the cap as well.
  const decoded = Buffer.from(tail.toString('utf8'));
  const text = utf8Tail(decoded, cap);
  return {
    kind: 'text',
    text: text.toString('utf8'),
    truncated: total > tail.length || text.length < decoded.length,
    totalBytes: total,
  };
}

export async function handleGithubChecksLogs(
  request: LogsRequest,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const answer = (log: CheckLog): ForgeResponse => ({
    operationId: request.operationId,
    ok: true,
    result: { op: request.op, value: { repo: request.repo, unit: request.unit, log } },
  });
  // A commit status is a state and a link; GitHub holds no log for it.
  if (request.unit.kind !== 'check') return answer({ kind: 'none', reason: 'unit_has_no_log' });
  const { root, path } = location(request.repo);
  const id = encodeURIComponent(request.unit.id);
  const run = checkRunSchema.parse(
    await githubRequest(fetchImpl, token, `${root}/repos/${path}/check-runs/${id}`)
  );
  // Another app's check run reports through its own output, not a job log.
  if (run.app?.slug !== 'github-actions')
    return answer({ kind: 'none', reason: 'unit_has_no_log' });
  return answer(
    await jobLog(
      fetchImpl,
      token,
      `${root}/repos/${path}/actions/jobs/${id}/logs`,
      request.maxBytes ?? CHECKS_LOGS_DEFAULT_BYTES
    )
  );
}
