export type WorktreeStatus = 'idle' | 'in_use' | 'stale';

export interface Worktree {
  id: string;
  projectId: string;
  branch: string;
  path: string;
  status: WorktreeStatus;
  daysSinceActivity: number;
  createdAt: string;
  updatedAt: string;
}

interface RawEnvironment {
  id: string;
  codebase_id: string;
  branch_name: string;
  working_path: string;
  status: string;
  created_at: string;
  updated_at: string;
  days_since_activity: number;
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
