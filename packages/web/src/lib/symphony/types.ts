import type { components } from '@/lib/api.generated';

export type SymphonyTrackerKind = components['schemas']['SymphonyTrackerKind'];
export type SymphonyDispatchStatus = components['schemas']['SymphonyDispatchStatus'];
export type SymphonyRunningRow = components['schemas']['SymphonyRunningRow'];
export type SymphonyRetryRow = components['schemas']['SymphonyRetryRow'];
export type SymphonyStateResponse = components['schemas']['SymphonyStateResponse'];
export type SymphonyDispatchRow = components['schemas']['SymphonyDispatchRow'];
export type SymphonyDispatchListResponse = components['schemas']['SymphonyDispatchListResponse'];
export type SymphonyDispatchActionBody = components['schemas']['SymphonyDispatchActionBody'];
export type SymphonyDispatchActionResponse =
  components['schemas']['SymphonyDispatchActionResponse'];
export type SymphonyRefreshResponse = components['schemas']['SymphonyRefreshResponse'];

export type Lifecycle = 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled';

export interface SymphonyCard {
  dispatch_key: string;
  tracker: SymphonyTrackerKind;
  issue_id: string;
  identifier: string;
  lifecycle: Lifecycle;
  status: string | null;
  workflow_name: string | null;
  workflow_run_id: string | null;
  attempt: number | null;
  due_at: string | null;
  last_error: string | null;
  started_at: string | null;
  dispatched_at: string | null;
}
