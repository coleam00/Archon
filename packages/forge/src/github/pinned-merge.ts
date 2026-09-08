import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  execBoundedProcess,
  FORGE_DISPATCH_DEFAULT_TIMEOUT_MS,
  pluginEnvironment,
  type ExecPluginOptions,
  type ExecPluginOutcome,
} from '../dispatch/exec';
import { parseRemoteUrl } from '../dispatch/dispatcher';
import type { RawOpOutcome } from '../dispatch/plugin-handle';
import { shaSchema, type ForgeOpError } from '../schemas';
import {
  PINNED_MERGE_OP,
  type PinnedMergeRequest,
  type MergeRecovery,
  type PinnedMergeResult,
  pinnedMergeResultSchema,
  pinnedMergePinsSchema,
} from '../pinned-merge-schemas';

export interface PinnedMergeOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  // Transport seams exercise the real operation and CAS in offline conformance tests.
  gitExec?: (args: string[], options: ExecPluginOptions) => Promise<ExecPluginOutcome>;
  temporaryId?: () => string;
}
const zero = '0'.repeat(40);
const commitSchema = z.object({
  oid: shaSchema,
  parents: z.object({ nodes: z.array(z.object({ oid: shaSchema })) }),
});
const refSchema = z.object({ target: z.object({ oid: shaSchema }) });
const repositorySchema = z.object({
  id: z.string(),
  nameWithOwner: z.string(),
  base: refSchema.nullable(),
  temporary: refSchema.nullable(),
  candidate: commitSchema.nullable(),
  pullRequest: z
    .object({
      number: z.number().int(),
      state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
      headRefName: z.string(),
      baseRefName: z.string(),
      headRefOid: shaSchema,
      headRepository: z.object({ id: z.string(), nameWithOwner: z.string() }).nullable(),
      mergeCommit: commitSchema.nullable(),
    })
    .nullable(),
});
type Repository = z.infer<typeof repositorySchema>;
const stateQuery = `query PinnedMergeState($owner:String!,$name:String!,$number:Int!,$base:String!,$temporary:String!,$candidate:GitObjectID!) {
  repository(owner:$owner,name:$name) {
    id nameWithOwner
    base:ref(qualifiedName:$base){target{oid}}
    temporary:ref(qualifiedName:$temporary){target{oid}}
    candidate:object(oid:$candidate){... on Commit{oid parents(first:3){nodes{oid}}}}
    pullRequest(number:$number){number state headRefName baseRefName headRefOid headRepository{id nameWithOwner} mergeCommit{oid parents(first:3){nodes{oid}}}}
  }
}`;
const updateMutation =
  'mutation PinnedMergeUpdate($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}';
class Refused extends Error {
  constructor(readonly error: ForgeOpError) {
    super(error.kind);
  }
}

export async function mergePinnedGitHub(
  request: PinnedMergeRequest,
  env: NodeJS.ProcessEnv,
  options: PinnedMergeOptions,
  signal?: AbortSignal
): Promise<RawOpOutcome> {
  const repo = request.ref.repo;
  const recovery: MergeRecovery = {
    ...pinnedMergePinsSchema.parse(request),
    publication: 'not_attempted',
    cleanup: 'not_needed',
  };
  const fail = (observed: string): never => {
    throw new Refused({
      kind: 'verify_failed',
      expected: 'Exact pinned PR, base, and composed commit',
      observed,
      recovery,
    });
  };
  if (repo.host !== 'github.com' || repo.path.split('/').length !== 2)
    return {
      kind: 'op_error',
      raw: { kind: 'unsupported_op', op: PINNED_MERGE_OP, plugin: 'github' },
    };
  const token = env.ARCHON_FORGE_TOKEN;
  if (!token) return { kind: 'op_error', raw: { kind: 'no_credential', host: repo.host } };
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const gitEnv = {
    ...pluginEnvironment(env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
  const gitExec =
    options.gitExec ??
    ((args, opts): Promise<ExecPluginOutcome> => {
      const command = Bun.which('git', { PATH: env.PATH ?? env.Path });
      if (!command) throw new Error('Git executable unavailable');
      return execBoundedProcess({ command, args }, [], opts);
    });
  async function git(args: string[], authenticated = false): Promise<string> {
    const config = authenticated
      ? {
          GIT_CONFIG_COUNT: '5',
          GIT_CONFIG_KEY_0: 'credential.helper',
          GIT_CONFIG_VALUE_0: '',
          GIT_CONFIG_KEY_1: 'http.extraHeader',
          GIT_CONFIG_VALUE_1: '',
          GIT_CONFIG_KEY_2: `http.https://${repo.host}/.extraHeader`,
          GIT_CONFIG_VALUE_2: `Authorization: ${authorization}`,
          GIT_CONFIG_KEY_3: 'http.followRedirects',
          GIT_CONFIG_VALUE_3: 'false',
          GIT_CONFIG_KEY_4: 'push.followTags',
          GIT_CONFIG_VALUE_4: 'false',
        }
      : {};
    const result = await gitExec(args, {
      cwd: request.checkout,
      env: { ...gitEnv, ...config },
      stdin: '',
      signal,
    });
    if (
      result.exitCode !== 0 ||
      result.cancelled ||
      result.timedOut ||
      result.bufferExceeded ||
      result.spawnError ||
      result.terminationError
    )
      fail('Git validation or upload failed; process output withheld to protect credentials');
    return result.stdout.trim();
  }
  async function api<T>(
    query: string,
    variables: unknown,
    schema: z.ZodType<T>,
    recovering = false
  ): Promise<T> {
    const timeout = AbortSignal.timeout(FORGE_DISPATCH_DEFAULT_TIMEOUT_MS);
    const bounded = signal && !recovering ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await (options.fetchImpl ?? fetch)(
      `${options.apiBase ?? 'https://api.github.com'}/graphql`,
      {
        method: 'POST',
        redirect: 'error',
        signal: bounded,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'archon-forge-github',
        },
        body: JSON.stringify({ query, variables }),
      }
    );
    if (!response.ok)
      throw new Refused({
        kind: 'forge_error',
        status: response.status,
        evidence: 'GitHub pinned merge request refused',
      });
    const envelope = z
      .object({
        data: z.unknown().optional(),
        errors: z.array(z.object({ type: z.string().optional(), message: z.string() })).optional(),
      })
      .parse(await response.json());
    if (envelope.errors?.length)
      throw new Refused({
        kind: 'forge_error',
        evidence: JSON.stringify(envelope.errors)
          .split(token ?? '')
          .join('[REDACTED]')
          .split(authorization.slice(6))
          .join('[REDACTED]'),
      });
    return schema.parse(envelope.data);
  }
  const id = (options.temporaryId ?? randomUUID)();
  if (!z.uuid().safeParse(id).success)
    return {
      kind: 'op_error',
      raw: { kind: 'invalid_request', detail: 'Invalid temporary ref identity' },
    };
  // Tags reject replacement without force. A fresh UUID owns each upload, including on retry.
  const temporary = `refs/tags/archon-merge-${id}`;
  const [owner, name] = repo.path.split('/');
  async function read(recovering = false): Promise<Repository> {
    const data = await api(
      stateQuery,
      {
        owner,
        name,
        number: request.ref.number,
        base: request.expected_base_ref,
        temporary,
        candidate: request.candidate_sha,
      },
      z.object({ repository: repositorySchema.nullable() }),
      recovering
    );
    if (data.repository?.nameWithOwner === repo.path) return data.repository;
    return fail('Repository identity differs');
  }
  function parents(commit: z.infer<typeof commitSchema> | null): boolean {
    return (
      commit?.oid === request.candidate_sha &&
      JSON.stringify(commit.parents.nodes.map(node => node.oid)) ===
        JSON.stringify([request.expected_base_sha, request.expected_head_sha])
    );
  }
  function identity(state: Repository): boolean {
    const pr = state.pullRequest;
    return (
      pr !== null &&
      pr.number === request.ref.number &&
      `refs/heads/${pr.headRefName}` === request.expected_head_ref &&
      `refs/heads/${pr.baseRefName}` === request.expected_base_ref &&
      pr.headRefOid === request.expected_head_sha
    );
  }
  function merged(state: Repository): boolean {
    return (
      identity(state) &&
      state.pullRequest?.state === 'MERGED' &&
      state.base?.target.oid === request.candidate_sha &&
      parents(state.candidate) &&
      parents(state.pullRequest.mergeCommit)
    );
  }
  async function update(
    repositoryId: string,
    changes: { name: string; beforeOid: string; afterOid: string; force: false }[],
    recovering = false
  ): Promise<void> {
    await api(
      updateMutation,
      { input: { repositoryId, refUpdates: changes } },
      z.object({ updateRefs: z.object({ clientMutationId: z.string().nullable() }) }),
      recovering
    );
  }
  let repositoryId: string | undefined;
  let uploadAttempted = false;
  let result: RawOpOutcome;
  try {
    signal?.throwIfAborted();
    if (!isAbsolute(request.checkout)) fail('Checkout must be absolute');
    if (request.expected_head_ref === request.expected_base_ref)
      fail('Head and base refs must differ');
    await git(['check-ref-format', request.expected_head_ref]);
    await git(['check-ref-format', request.expected_base_ref]);
    const remote = parseRemoteUrl(await git(['remote', 'get-url', 'origin']));
    if (remote?.host !== repo.host || remote.path !== repo.path)
      fail('Checkout origin differs from qualified destination');
    const url = `https://${repo.host}/${repo.path}.git`;
    if ((await git(['ls-remote', '--get-url', url])) !== url)
      fail('Git URL rewriting changes the destination');
    if ((await git(['rev-parse', '--verify', 'HEAD'])) !== request.candidate_sha)
      fail('Checkout HEAD differs from tested candidate');
    if (await git(['status', '--porcelain=v1', '--untracked-files=all']))
      fail('Checkout has uncommitted changes');
    const raw = await git(['cat-file', 'commit', request.candidate_sha]);
    const actualParents = raw
      .split('\n\n', 1)[0]
      .split('\n')
      .filter(line => line.startsWith('parent '))
      .map(line => line.slice(7));
    if (
      JSON.stringify(actualParents) !==
      JSON.stringify([request.expected_base_sha, request.expected_head_sha])
    )
      fail('Candidate parents differ or are out of order');
    const state = await read();
    repositoryId = state.id;
    if (
      state.pullRequest?.headRepository?.id !== state.id ||
      state.pullRequest.headRepository.nameWithOwner !== repo.path
    )
      throw new Refused({ kind: 'unsupported_op', op: PINNED_MERGE_OP, plugin: 'github' });
    if (merged(state)) {
      recovery.publication = 'applied';
      return {
        kind: 'ok',
        value: {
          ...recovery,
          publication: 'applied',
          status: 'already_merged',
        } satisfies PinnedMergeResult,
      };
    }
    if (
      !identity(state) ||
      state.pullRequest?.state !== 'OPEN' ||
      state.base?.target.oid !== request.expected_base_sha
    )
      fail('PR identity, state, head or base changed');
    if (state.temporary) fail('Temporary ref collision; existing ref was not touched');
    signal?.throwIfAborted();
    uploadAttempted = true;
    recovery.temporary_ref = temporary;
    recovery.cleanup = 'unknown';
    await git(['push', '--porcelain', '--', url, `${request.candidate_sha}:${temporary}`], true);
    const uploaded = await read();
    if (uploaded.temporary?.target.oid !== request.candidate_sha || !parents(uploaded.candidate))
      fail('Uploaded candidate identity differs');
    if (
      !identity(uploaded) ||
      uploaded.pullRequest?.state !== 'OPEN' ||
      uploaded.base?.target.oid !== request.expected_base_sha
    )
      fail('PR or base moved during upload');
    if (
      (await git(['rev-parse', '--verify', 'HEAD'])) !== request.candidate_sha ||
      (await git(['status', '--porcelain=v1', '--untracked-files=all']))
    )
      fail('Checkout changed during upload');
    signal?.throwIfAborted();
    recovery.publication = 'unknown';
    let mutationError: unknown;
    try {
      // The head no-op and base CAS are ONE atomic server operation. Neither read is the guard.
      await update(state.id, [
        {
          name: request.expected_head_ref,
          beforeOid: request.expected_head_sha,
          afterOid: request.expected_head_sha,
          force: false,
        },
        {
          name: request.expected_base_ref,
          beforeOid: request.expected_base_sha,
          afterOid: request.candidate_sha,
          force: false,
        },
      ]);
      recovery.publication = 'applied';
    } catch (error) {
      mutationError = error;
    }
    // A lost response or cancellation never authorizes a second mutation. Reconcile with reads.
    const after = await read(true);
    if (!merged(after)) {
      if (after.base?.target.oid === request.candidate_sha && parents(after.candidate))
        recovery.publication = 'applied';
      if (
        identity(after) &&
        after.base?.target.oid === request.expected_base_sha &&
        mutationError instanceof Refused &&
        mutationError.error.kind === 'forge_error'
      )
        throw new Refused({ ...mutationError.error, recovery });
      fail('Exact merged PR and composed base could not be verified');
    }
    recovery.publication = 'applied';
    result = {
      kind: 'ok',
      value: { ...recovery, publication: 'applied', status: 'merged' } satisfies PinnedMergeResult,
    };
  } catch (error) {
    result = {
      kind: 'op_error',
      raw:
        error instanceof Refused
          ? error.error.kind === 'forge_error'
            ? { ...error.error, recovery }
            : error.error
          : {
              kind: 'verify_failed',
              expected: 'Verified pinned merge outcome',
              observed: 'Operation interrupted or read-back unavailable; reconcile before retry',
              recovery,
            },
    };
  }
  if (uploadAttempted && repositoryId) {
    try {
      const remaining = await read(true);
      if (!remaining.temporary) recovery.cleanup = 'removed';
      else if (remaining.temporary.target.oid !== request.candidate_sha)
        recovery.cleanup = 'retained';
      else {
        // Conditional deletion prevents cleanup from deleting a ref moved by another writer.
        await update(
          repositoryId,
          [{ name: temporary, beforeOid: request.candidate_sha, afterOid: zero, force: false }],
          true
        );
        recovery.cleanup = (await read(true)).temporary ? 'retained' : 'removed';
      }
    } catch {
      recovery.cleanup = 'unknown';
    }
    if (result.kind === 'ok')
      result = {
        kind: 'ok',
        value: { ...pinnedMergeResultSchema.parse(result.value), ...recovery },
      };
  }
  return result;
}
