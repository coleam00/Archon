// @archon/symphony — autonomous Linear+GitHub tracker dispatch on top of Archon workflows.
//
// Phase 2 (this commit): tracker port (Linear + GitHub), orchestrator with
// slot accounting and retry, stub dispatchIssue that writes a
// symphony_dispatches row and logs symphony.dispatch_skipped.
//
// Phase 3 will replace the stub with a real call to executeWorkflow and
// wire this service into the Archon server process.

export type {
  DispatchRow,
  DispatchStatus,
  DispatchTracker,
  InsertDispatchInput,
} from './db/dispatches';

export type {
  BlockerRef,
  CommentOnIssueInput,
  CreateIssueInput,
  Issue,
  Tracker,
} from './tracker/types';

export type {
  ConfigSnapshot,
  CodebaseMapping,
  DispatchConfig,
  PollingConfig,
  RetryConfig,
  TrackerConfig,
  TrackerGitHubConfig,
  TrackerKind,
  TrackerLinearConfig,
} from './config/snapshot';

export type {
  CancelResult,
  DispatchResult,
  OrchestratorDeps,
  OrchestratorRetryRow,
  OrchestratorRunningRow,
  OrchestratorSnapshotView,
  TrackerMap,
} from './orchestrator/orchestrator';

export { Orchestrator } from './orchestrator/orchestrator';
export { LinearTracker } from './tracker/linear';
export { GitHubTracker } from './tracker/github';
export { buildSnapshot, SnapshotBuildError } from './config/snapshot';
export { parseSymphonyConfig, ConfigError } from './config/parse';
export {
  startSymphonyService,
  type StartSymphonyServiceOptions,
  type SymphonyServiceHandle,
} from './service';
