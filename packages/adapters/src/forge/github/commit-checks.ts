/**
 * Checks on one GitHub commit: `checks.state` reads them at a pull request's head,
 * `checks.commit` at a given revision or at the default branch's head.
 */
import { z } from 'zod';
import { checkPhase, checkResult } from './normalize-event';
import {
  type CheckObservation,
  type ForgeError,
  type ForgeRequest,
  type ForgeResponse,
  concludedCheckStates,
  summarizeChecks,
} from '@archon/forge/operations';
import type { RepoRef } from '@archon/forge';
import {
  githubGraphql,
  githubPages,
  githubRepository,
  githubRequest,
  location,
  type Fetch,
} from './api';
import { readWorkflowRuns } from './workflow-runs';

const pullRequestSchema = z.object({ head: z.object({ sha: z.string().min(1) }) });
const checkRunSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]),
  name: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().nullable().optional(),
  head_sha: z.string().optional(),
  check_suite: z.object({ id: z.number().int() }).nullable().optional(),
  app: z.object({ slug: z.string().nullable().optional() }).nullable().optional(),
});
const checkRunsPageSchema = z.object({ check_runs: z.array(checkRunSchema) });
const statusSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]),
  context: z.string().min(1),
  state: z.string().min(1),
});
const statusesPageSchema = z.array(statusSchema);
const defaultBranchSchema = z.object({
  repository: z
    .object({
      defaultBranchRef: z
        .object({ name: z.string().min(1), target: z.object({ oid: z.string().min(1) }) })
        .nullable(),
    })
    .nullable(),
});

function failure(operationId: string, error: ForgeError): ForgeResponse {
  return { operationId, ok: false, error };
}

function checkRunObservation(run: z.infer<typeof checkRunSchema>): CheckObservation {
  const nativeResult = run.conclusion ?? null;
  const normalizedResult = checkResult(nativeResult);
  if (['queued', 'waiting', 'pending', 'in_progress'].includes(run.status)) {
    return {
      unit: { kind: 'check', id: String(run.id), name: run.name },
      nativeState: run.status,
      phase: checkPhase(run.status),
      nativeResult,
      result: normalizedResult,
      state: 'pending',
    };
  }
  const state =
    run.status !== 'completed' || normalizedResult === null
      ? 'unknown'
      : concludedCheckStates[normalizedResult];
  return {
    unit: { kind: 'check', id: String(run.id), name: run.name },
    nativeState: run.status,
    phase: checkPhase(run.status),
    nativeResult,
    result: normalizedResult,
    state,
  };
}

function statusObservation(status: z.infer<typeof statusSchema>): CheckObservation {
  const state =
    status.state === 'pending'
      ? 'pending'
      : status.state === 'success'
        ? 'green'
        : status.state === 'failure' || status.state === 'error'
          ? 'red'
          : 'unknown';
  return {
    unit: { kind: 'commit_status', id: String(status.id), name: status.context },
    nativeState: status.state,
    phase: checkPhase(status.state),
    nativeResult: status.state,
    result:
      status.state === 'pending'
        ? null
        : checkResult(status.state === 'error' ? 'failure' : status.state),
    state,
  };
}

/** Every check run and the latest status per context on `revision`, with each run's rerun group. */
async function readCommitChecks(
  fetchImpl: Fetch,
  token: string,
  repo: RepoRef,
  revision: string
): Promise<{
  units: CheckObservation[];
  summary: ReturnType<typeof summarizeChecks>;
  approvalPending: boolean;
}> {
  const { root, path } = location(repo);
  const ref = encodeURIComponent(revision);
  const [runs, allStatuses, workflows] = await Promise.all([
    githubPages(
      fetchImpl,
      token,
      `${root}/repos/${path}/commits/${ref}/check-runs?filter=latest`,
      value => checkRunsPageSchema.parse(value).check_runs
    ),
    githubPages(fetchImpl, token, `${root}/repos/${path}/commits/${ref}/statuses`, value =>
      statusesPageSchema.parse(value)
    ),
    readWorkflowRuns(fetchImpl, token, repo, revision),
  ]);
  // GitHub returns statuses newest first. Context names are case-insensitive, so the
  // first row for each folded context is the authoritative latest status unit.
  const contexts = new Set<string>();
  const statuses = allStatuses.filter(status => {
    const context = status.context.toLowerCase();
    if (contexts.has(context)) return false;
    contexts.add(context);
    return true;
  });
  const units = [
    ...runs.map(run => {
      const associated = workflows.filter(
        workflow =>
          workflow.head_sha === revision && workflow.check_suite_id === run.check_suite?.id
      );
      const workflow = associated.length === 1 ? associated[0] : undefined;
      return {
        ...checkRunObservation(run),
        rerun:
          run.app?.slug === 'github-actions' && run.head_sha === revision && workflow
            ? { id: String(workflow.id), attempt: workflow.run_attempt }
            : null,
      };
    }),
    ...statuses.map(status => ({ ...statusObservation(status), rerun: null })),
  ];
  return {
    units,
    summary: summarizeChecks(units),
    approvalPending:
      workflows.some(run => run.head_sha === revision && run.conclusion === 'action_required') ||
      units.some(unit => unit.result === 'action_required'),
  };
}

export async function handleGithubChecksState(
  request: Extract<ForgeRequest, { op: 'checks.state' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const { root, path } = location(request.ref.repo);
  const pull = pullRequestSchema.parse(
    await githubRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/pulls/${String(request.ref.number)}`
    )
  );
  const revision = pull.head.sha;
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'checks.state',
      value: {
        ref: request.ref,
        revision,
        ...(await readCommitChecks(fetchImpl, token, request.ref.repo, revision)),
        // The check-runs and statuses APIs enumerate observations but do not say which
        // checks branch protection requires. Returning null keeps that absence explicit.
        required: null,
      },
    },
  };
}

async function defaultBranchHead(
  fetchImpl: Fetch,
  token: string,
  repo: RepoRef
): Promise<{ branch: string; revision: string } | null> {
  const name = githubRepository(repo);
  const data = defaultBranchSchema.parse(
    await githubGraphql(
      fetchImpl,
      token,
      repo,
      'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name target{oid}}}}',
      { owner: name.owner, name: name.repo }
    )
  );
  const ref = data.repository?.defaultBranchRef;
  return ref ? { branch: ref.name, revision: ref.target.oid } : null;
}

export async function handleGithubChecksCommit(
  request: Extract<ForgeRequest, { op: 'checks.commit' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const at =
    request.at.kind === 'revision'
      ? { branch: null, revision: request.at.revision }
      : await defaultBranchHead(fetchImpl, token, request.repo);
  if (!at)
    return failure(request.operationId, {
      kind: 'not_found',
      message: `${request.repo.path} reports no default branch`,
    });
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'checks.commit',
      value: {
        repo: request.repo,
        ...at,
        ...(await readCommitChecks(fetchImpl, token, request.repo, at.revision)),
      },
    },
  };
}
