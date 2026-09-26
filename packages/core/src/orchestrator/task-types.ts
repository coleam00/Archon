/** Supported labels from the local direct-chat task classifier. */
export const ORCHESTRATOR_TASK_TYPES = [
  'question',
  'project_work',
  'project_setup',
  'run_management',
  'unclear',
] as const;

export type OrchestratorTaskType = (typeof ORCHESTRATOR_TASK_TYPES)[number];
