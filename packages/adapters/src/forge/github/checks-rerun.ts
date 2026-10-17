import { z } from 'zod';
import {
  type ForgeMutationRequest,
  type ForgeResponse,
  type SelectedCheck,
} from '@archon/forge/operations';
import { GitHubError, githubErrorDetail, githubRequest, location, type Fetch } from './api';
import { workflowRunSchema } from './workflow-runs';

export async function handleGithubChecksRerun(
  request: Extract<ForgeMutationRequest, { op: 'checks.rerun' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const observed: SelectedCheck[] = [];
  let acknowledged = false;
  let submitted = false;
  let currentAcknowledged = false;
  const fail = (
    outcome: 'refused' | 'verification_failed' | 'outcome_unknown',
    cause: unknown
  ): ForgeResponse => ({
    operationId: request.operationId,
    ok: false,
    error: githubErrorDetail(cause),
    mutation: {
      op: request.op,
      target: request.ref,
      ...(outcome === 'verification_failed'
        ? { outcome, leaveBehind: 'acknowledged workflow reruns may remain' }
        : { outcome }),
      rerun: { revision: request.revision, requested: request.units, observed },
    },
  });
  const refuse = (message: string, kind: 'conflict' | 'unsupported_op' = 'conflict'): never => {
    throw new GitHubError({ kind, message }, true);
  };
  try {
    const { root, path } = location(request.ref.repo);
    const base = `${root}/repos/${path}`;
    const pull = z
      .object({ head: z.object({ sha: z.string() }) })
      .parse(await githubRequest(fetchImpl, token, `${base}/pulls/${String(request.ref.number)}`));
    if (pull.head.sha !== request.revision) refuse('Pull request head differs from rerun revision');
    const groups = new Map<string, { attempt: number; suiteId: number; units: SelectedCheck[] }>();
    for (const selected of request.units) {
      if (selected.unit.kind !== 'check')
        refuse('Selected unit does not support reruns', 'unsupported_op');
      const rerun = selected.rerun;
      if (!rerun)
        throw new GitHubError(
          { kind: 'unsupported_op', message: 'Selected unit does not support reruns' },
          true
        );
      const check = z
        .object({
          id: z.union([z.number(), z.string()]),
          name: z.string(),
          head_sha: z.string(),
          status: z.string(),
          conclusion: z.string().nullable(),
          app: z.object({ slug: z.string().nullable() }).nullable(),
          check_suite: z.object({ id: z.number() }).nullable(),
        })
        .parse(
          await githubRequest(
            fetchImpl,
            token,
            `${base}/check-runs/${encodeURIComponent(selected.unit.id)}`
          )
        );
      if (!check.check_suite)
        throw new GitHubError(
          { kind: 'unsupported_op', message: 'Check has no owning suite' },
          true
        );
      if (check.app?.slug !== 'github-actions')
        refuse('Only GitHub Actions checks support reruns', 'unsupported_op');
      if (
        String(check.id) !== selected.unit.id ||
        check.name !== selected.unit.name ||
        check.head_sha !== request.revision ||
        check.status !== 'completed' ||
        !['failure', 'cancelled', 'timed_out'].includes(check.conclusion ?? '')
      )
        refuse('Selected check is not an eligible failed check at the requested revision');
      const run = workflowRunSchema.parse(
        await githubRequest(
          fetchImpl,
          token,
          `${base}/actions/runs/${encodeURIComponent(rerun.id)}`
        )
      );
      if (
        String(run.id) !== rerun.id ||
        run.head_sha !== request.revision ||
        run.check_suite_id === null ||
        run.check_suite_id !== check.check_suite?.id ||
        run.run_attempt !== rerun.attempt ||
        run.status !== 'completed' ||
        !['failure', 'cancelled', 'timed_out'].includes(run.conclusion ?? '')
      )
        refuse('Workflow run does not match the selected failed check and attempt');
      const group = groups.get(rerun.id);
      if (group && group.attempt !== rerun.attempt)
        refuse('Selected units disagree on workflow attempt');
      if (group) group.units.push(selected);
      else
        groups.set(rerun.id, {
          attempt: rerun.attempt,
          suiteId: check.check_suite.id,
          units: [selected],
        });
    }
    for (const [id, group] of groups) {
      submitted = true;
      currentAcknowledged = false;
      await githubRequest(
        fetchImpl,
        token,
        `${base}/actions/runs/${encodeURIComponent(id)}/rerun-failed-jobs`,
        { method: 'POST' },
        () => {
          acknowledged = true;
          currentAcknowledged = true;
        },
        'empty'
      );
      const run = workflowRunSchema.parse(
        await githubRequest(fetchImpl, token, `${base}/actions/runs/${encodeURIComponent(id)}`)
      );
      if (
        String(run.id) !== id ||
        run.head_sha !== request.revision ||
        run.check_suite_id !== group.suiteId ||
        run.run_attempt <= group.attempt
      )
        throw new GitHubError({
          kind: 'invalid_response',
          message: 'Workflow rerun read-back did not establish a newer attempt',
        });
      observed.push(
        ...group.units.map(selected => ({
          unit: selected.unit,
          rerun: { id, attempt: run.run_attempt },
        }))
      );
      submitted = false;
    }
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
  } catch (cause) {
    const definitive = cause instanceof GitHubError && cause.definitiveRefusal;
    return fail(
      currentAcknowledged || (acknowledged && (!submitted || definitive))
        ? 'verification_failed'
        : submitted && !definitive
          ? 'outcome_unknown'
          : 'refused',
      cause
    );
  }
}
