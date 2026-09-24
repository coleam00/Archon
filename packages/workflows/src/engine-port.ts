import type { IWorkflowPlatform } from './deps';
import type { ExecuteWorkflowOptions } from './executor';
import type { WorkflowResumeCursor } from './store';
import type { ResolvedWorkflow, WorkflowRun, WorkflowExecutionResult } from './schemas';

// These lists own both the public input exclusions and their runtime validation.
export const FRESH_RUN_FORBIDDEN_OPTIONS = [
  'priorCompletedNodes',
  'priorUsage',
  'priorNodeSessions',
] as const satisfies readonly (keyof ExecuteWorkflowOptions)[];

export const RESUME_FORBIDDEN_OPTIONS = [
  ...FRESH_RUN_FORBIDDEN_OPTIONS,
  'preCreatedRun',
  'runConfig',
  'modelOverrideLayer',
  'inputs',
  'preparedSource',
  'capturedSourceOwner',
  'adoptedFromRunId',
  'continuationMode',
  'cutFromCommit',
] as const satisfies readonly (keyof ExecuteWorkflowOptions)[];

type WithoutOptions<Key extends keyof ExecuteWorkflowOptions> = Omit<ExecuteWorkflowOptions, Key> &
  Partial<Record<Key, never>>;

export type WorkflowSubmitOptions = WithoutOptions<(typeof FRESH_RUN_FORBIDDEN_OPTIONS)[number]>;
export type WorkflowResumeOptions = WithoutOptions<(typeof RESUME_FORBIDDEN_OPTIONS)[number]>;

interface WorkflowEngineCallBase {
  platform: IWorkflowPlatform;
  conversationId: string;
  cwd: string;
  userMessage: string;
  conversationDbId: string;
}

export interface WorkflowEngineSubmitInput extends WorkflowEngineCallBase {
  workflow: ResolvedWorkflow;
  /** A pre-created row must still be pending; replay state belongs to resume. */
  options?: WorkflowSubmitOptions;
}

export interface WorkflowResumeInput extends WorkflowEngineCallBase {
  run: WorkflowRun;
  /** Used only for runs created before frozen workflow-source captures existed. */
  legacyWorkflow?: ResolvedWorkflow;
  cursor?: WorkflowResumeCursor;
  options?: WorkflowResumeOptions;
}

export type WorkflowResumeAdmission =
  | { accepted: false; reason: 'nothing-to-resume' }
  | {
      accepted: true;
      runId: string;
      /** Settles this execution segment, which may pause rather than finish the run. */
      settled: Promise<WorkflowExecutionResult>;
    };

/** Hosts supply execution context; the implementation owns its dependencies. */
export interface IWorkflowEngine {
  submit(input: WorkflowEngineSubmitInput): Promise<WorkflowExecutionResult>;
  /** Claims and starts a continuation before returning acceptance. */
  resume(input: WorkflowResumeInput): Promise<WorkflowResumeAdmission>;
}
