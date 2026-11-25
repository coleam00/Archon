import { requestJson } from '../lib/http';
import { toWorktree, type Worktree } from '../primitives/worktree';

export async function listWorktrees(projectId: string): Promise<Worktree[]> {
  const res = await requestJson('/api/codebases/{id}/environments', 'get', {
    params: { id: projectId },
  });
  return res.environments.map(toWorktree);
}
