import { z } from 'zod';
import {
  type ForgeMutationRequest,
  type ForgeResponse,
  type SelectedCheck,
} from '@archon/forge/operations';
import { GitHubError, githubErrorDetail, githubRequest, location, type Fetch } from './api';
import { workflowRunSchema, type WorkflowRun } from './workflow-runs';

type RerunRequest = Extract<ForgeMutationRequest, { op: 'checks.rerun' }>;
type RerunGroup = { attempt: number; suiteId: number; units: SelectedCheck[] };

interface RerunContext {
  fetchImpl: Fetch;
  token: string;
  base: string;
  revision: string;
}

/** How far the write phase got, so a failure can say whether a rerun may already have started. */
interface RerunProgress {
  observed: SelectedCheck[];
  acknowledged: boolean;
  submitted: boolean;
  currentAcknowledged: boolean;
}

const FAILED_CONCLUSIONS = ['failure', 'cancelled', 'timed_out'];

const checkRunSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  app: z.object({ slug: z.string().nullable() }).nullable(),
  check_suite: z.object({ id: z.number() }).nullable(),
});
type CheckRun = z.infer<typeof checkRunSchema>;

export async function handleGithubChecksRerun(
  request: RerunRequest,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const progress: RerunProgress = {
    observed: [],
    acknowledged: false,
    submitted: false,
    currentAcknowledged: false,
  };
  try {
    const { root, path } = location(request.ref.repo);
    const github: RerunContext = {
      fetchImpl,
      token,
      base: `${root}/repos/${path}`,
      revision: request.revision,
    };
    await requirePullHead(github, request.ref.number);
    const groups = await eligibleRerunGroups(github, request.units);
    for (const [id, group] of groups) await rerunGroup(github, id, group, progress);
    return appliedResponse(request, progress.observed);
  } catch (cause) {
    return failedResponse(request, progress, cause);
  }
}

function refuse(message: string, kind: 'conflict' | 'unsupported_op' = 'conflict'): never {
  throw new GitHubError({ kind, message }, true);
}

async function requirePullHead(github: RerunContext, number: number): Promise<void> {
  const pull = z
    .object({ head: z.object({ sha: z.string() }) })
    .parse(await githubGet(github, `pulls/${String(number)}`));
  if (pull.head.sha !== github.revision) refuse('Pull request head differs from rerun revision');
}

/** Validates every selected unit before any write, grouping the units by owning workflow run. */
async function eligibleRerunGroups(
  github: RerunContext,
  units: SelectedCheck[]
): Promise<Map<string, RerunGroup>> {
  const groups = new Map<string, RerunGroup>();
  for (const selected of units) {
    const { rerun, suiteId } = await eligibleFailedCheck(github, selected);
    const group = groups.get(rerun.id);
    if (group && group.attempt !== rerun.attempt)
      refuse('Selected units disagree on workflow attempt');
    if (group) group.units.push(selected);
    else groups.set(rerun.id, { attempt: rerun.attempt, suiteId, units: [selected] });
  }
  return groups;
}

async function eligibleFailedCheck(
  github: RerunContext,
  selected: SelectedCheck
): Promise<{ rerun: NonNullable<SelectedCheck['rerun']>; suiteId: number }> {
  if (selected.unit.kind !== 'check')
    refuse('Selected unit does not support reruns', 'unsupported_op');
  const rerun = selected.rerun;
  if (!rerun) refuse('Selected unit does not support reruns', 'unsupported_op');
  const check = checkRunSchema.parse(
    await githubGet(github, `check-runs/${encodeURIComponent(selected.unit.id)}`)
  );
  if (!check.check_suite) refuse('Check has no owning suite', 'unsupported_op');
  if (check.app?.slug !== 'github-actions')
    refuse('Only GitHub Actions checks support reruns', 'unsupported_op');
  if (!isFailedCheck(check, selected.unit, github.revision))
    refuse('Selected check is not an eligible failed check at the requested revision');
  const suiteId = check.check_suite.id;
  const run = workflowRunSchema.parse(
    await githubGet(github, `actions/runs/${encodeURIComponent(rerun.id)}`)
  );
  if (!isFailedRunAttempt(run, rerun, suiteId, github.revision))
    refuse('Workflow run does not match the selected failed check and attempt');
  return { rerun, suiteId };
}

function isFailedCheck(check: CheckRun, unit: SelectedCheck['unit'], revision: string): boolean {
  return (
    String(check.id) === unit.id &&
    check.name === unit.name &&
    check.head_sha === revision &&
    check.status === 'completed' &&
    FAILED_CONCLUSIONS.includes(check.conclusion ?? '')
  );
}

function isFailedRunAttempt(
  run: WorkflowRun,
  rerun: NonNullable<SelectedCheck['rerun']>,
  suiteId: number,
  revision: string
): boolean {
  return (
    String(run.id) === rerun.id &&
    run.head_sha === revision &&
    run.check_suite_id === suiteId &&
    run.run_attempt === rerun.attempt &&
    run.status === 'completed' &&
    FAILED_CONCLUSIONS.includes(run.conclusion ?? '')
  );
}

/** Reruns one workflow run's failed jobs and reads it back to prove a newer attempt started. */
async function rerunGroup(
  github: RerunContext,
  id: string,
  group: RerunGroup,
  progress: RerunProgress
): Promise<void> {
  progress.submitted = true;
  progress.currentAcknowledged = false;
  await githubRequest(
    github.fetchImpl,
    github.token,
    `${github.base}/actions/runs/${encodeURIComponent(id)}/rerun-failed-jobs`,
    { method: 'POST' },
    () => {
      progress.acknowledged = true;
      progress.currentAcknowledged = true;
    },
    'empty'
  );
  const run = workflowRunSchema.parse(
    await githubGet(github, `actions/runs/${encodeURIComponent(id)}`)
  );
  if (
    String(run.id) !== id ||
    run.head_sha !== github.revision ||
    run.check_suite_id !== group.suiteId ||
    run.run_attempt <= group.attempt
  )
    throw new GitHubError({
      kind: 'invalid_response',
      message: 'Workflow rerun read-back did not establish a newer attempt',
    });
  progress.observed.push(
    ...group.units.map(selected => ({
      unit: selected.unit,
      rerun: { id, attempt: run.run_attempt },
    }))
  );
  progress.submitted = false;
}

function githubGet(github: RerunContext, path: string): Promise<unknown> {
  return githubRequest(github.fetchImpl, github.token, `${github.base}/${path}`);
}

function appliedResponse(request: RerunRequest, observed: SelectedCheck[]): ForgeResponse {
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: {
        target: request.ref,
        outcome: 'applied',
        changed: true,
        ref: request.ref,
        revision: request.revision,
        units: observed,
      },
    },
  };
}

function failedResponse(
  request: RerunRequest,
  progress: RerunProgress,
  cause: unknown
): ForgeResponse {
  const outcome = failureOutcome(progress, cause);
  return {
    operationId: request.operationId,
    ok: false,
    error: githubErrorDetail(cause),
    mutation: {
      op: request.op,
      target: request.ref,
      ...(outcome === 'verification_failed'
        ? { outcome, leaveBehind: 'acknowledged workflow reruns may remain' }
        : { outcome }),
      rerun: { revision: request.revision, requested: request.units, observed: progress.observed },
    },
  };
}

/**
 * An acknowledged write makes the failure a verification failure; a write in flight with no
 * definitive refusal leaves the outcome unknown; anything before the first write is a refusal.
 */
function failureOutcome(
  progress: RerunProgress,
  cause: unknown
): 'refused' | 'verification_failed' | 'outcome_unknown' {
  const definitive = cause instanceof GitHubError && cause.definitiveRefusal;
  if (
    progress.currentAcknowledged ||
    (progress.acknowledged && (!progress.submitted || definitive))
  )
    return 'verification_failed';
  return progress.submitted && !definitive ? 'outcome_unknown' : 'refused';
}
