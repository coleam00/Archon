import type { components } from '@/lib/api.generated';
type RawEnvironment = Pick<
  components['schemas']['IsolationEnvironment'],
  | 'id'
  | 'codebase_id'
  | 'branch_name'
  | 'working_path'
  | 'status'
  | 'created_at'
  | 'updated_at'
  | 'days_since_activity'
>;
export type WorktreeStatus = 'idle' | 'in_use' | 'stale';

export interface Worktree {
  id: RawEnvironment['id'];
  projectId: RawEnvironment['codebase_id'];
  branch: RawEnvironment['branch_name'];
  path: RawEnvironment['working_path'];
  status: WorktreeStatus;
  daysSinceActivity: RawEnvironment['days_since_activity'];
  createdAt: RawEnvironment['created_at'];
  updatedAt: RawEnvironment['updated_at'];
}

function normalizeStatus(s: string, days: number): WorktreeStatus {
  if (s === 'in_use' || s === 'active') return 'in_use';
  if (days > 14) return 'stale';
  return 'idle';
}

export function toWorktree(raw: RawEnvironment): Worktree {
  return {
    id: raw.id,
    projectId: raw.codebase_id,
    branch: raw.branch_name,
    path: raw.working_path,
    status: normalizeStatus(raw.status, raw.days_since_activity),
    daysSinceActivity: raw.days_since_activity,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}
