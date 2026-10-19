import { z } from 'zod';
import type { RepoRef } from '@archon/forge';
import { GitHubError, githubPages, location, type Fetch } from './api';

export const workflowRunSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  head_sha: z.string().min(1),
  check_suite_id: z.number().int().nullable(),
  run_attempt: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export async function readWorkflowRuns(
  fetchImpl: Fetch,
  token: string,
  repo: RepoRef,
  revision: string
): Promise<WorkflowRun[]> {
  const { root, path } = location(repo);
  let total: number | undefined;
  const runs = await githubPages(
    fetchImpl,
    token,
    `${root}/repos/${path}/actions/runs?head_sha=${encodeURIComponent(revision)}`,
    value => {
      const page = z
        .object({
          total_count: z.number().int().nonnegative(),
          workflow_runs: z.array(workflowRunSchema),
        })
        .parse(value);
      // GitHub caps filtered workflow-run searches at 1,000 results.
      if (page.total_count > 1000)
        throw new GitHubError({
          kind: 'forge_error',
          message: 'Workflow-run search exceeds the GitHub 1,000-result limit',
        });
      if (total !== undefined && total !== page.total_count)
        throw new GitHubError({
          kind: 'forge_error',
          message: 'Workflow-run count changed during pagination',
        });
      total = page.total_count;
      return page.workflow_runs;
    }
  );
  if (runs.length !== total)
    throw new GitHubError({ kind: 'forge_error', message: 'Incomplete workflow-run enumeration' });
  return runs;
}

export function workflowApprovalPending(
  runs: readonly WorkflowRun[],
  revision: string
): boolean | null {
  if (runs.some(run => run.head_sha === revision && run.conclusion === 'action_required'))
    return true;
  if (runs.some(run => run.head_sha !== revision || run.status !== 'completed' || !run.conclusion))
    return null;
  return false;
}
