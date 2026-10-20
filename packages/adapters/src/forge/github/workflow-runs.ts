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
  return githubPages(
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
      return page.workflow_runs;
    }
  );
}
