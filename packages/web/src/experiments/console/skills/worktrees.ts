import { requestJson } from '../lib/http';
import { toWorktree, type Worktree } from '../primitives/worktree';

interface EnvironmentsResponse {
  environments: Parameters<typeof toWorktree>[0][];
}

export async function listWorktrees(projectId: string): Promise<Worktree[]> {
  const res = await requestJson<EnvironmentsResponse>(
    `/api/codebases/${encodeURIComponent(projectId)}/environments`
  );
  return res.environments.map(toWorktree);
}
