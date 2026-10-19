/**
 * Shared workflow business logic — approve, reject, status, resume, abandon.
 *
 * Both CLI and command-handler are thin formatting adapters over these functions.
 * Operations throw on errors; callers catch and format for their platform. Each
 * operation lives in its own module under `./workflow/`; this factory composes them
 * over one set of supplied effects, and this path is the public entry for all of them.
 */
import type { RecordSurface } from '@archon/workflows/schemas/record-surface';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { SignalWorkflowWaitRequest } from '../schemas/workflow-run';
import type { RunActor, RunAction } from './run-authorization';
import { createOperationContext, type WorkflowOperationsDeps } from './workflow/context';
import type { GateAnswerOrigin } from './workflow/answer-admission';
import {
  answerWorkflow,
  type AttentionAnswerOperationResult,
  type AttentionAnswerRequest,
} from './workflow/answer';
import {
  labelAttentionWait,
  type AttentionLabelRequest,
  type AttentionLabelResult,
} from './workflow/label';
import { approveWorkflow, type ApprovalOperationResult } from './workflow/approve';
import { rejectWorkflow, type RejectionOperationResult } from './workflow/reject';
import { respondToWorkflow } from './workflow/respond';
import {
  abandonResumableRunsForConversation,
  abandonWorkflow,
  type AbandonConversationRunsResult,
} from './workflow/abandon';
import { cancelWorkflow, type CancelWorkflowResult } from './workflow/cancel';
import type { AbandonOwnerOutcome, AbandonWorkflowResult } from './workflow/teardown';
import {
  deleteWorkflowRun,
  getWorkflowStatus,
  resetWorkflowNodeSessions,
  resumeWorkflow,
  signalWorkflowWait,
  type WorkflowStatusData,
} from './workflow/run-actions';

export type { RunActionStore, WorkflowOperationsDeps } from './workflow/context';
export {
  assertAnswerAdmissible,
  ChildRunRedirectError,
  expectedGateForOccurrence,
  StaleGateAnswerError,
  workflowOperationErrorMessage,
  type GateAnswerOrigin,
} from './workflow/answer-admission';
export {
  assertAnswerable,
  attentionAnswerFor,
  attentionSugarRequest,
  type AttentionAnswerOperationResult,
  type AttentionAnswerRequest,
} from './workflow/answer';
export {
  assertLabelable,
  type AttentionLabelRequest,
  type AttentionLabelResult,
} from './workflow/label';
export { assertApprovable, type ApprovalOperationResult } from './workflow/approve';
export {
  assertRejectable,
  isRejectableUnreadableGate,
  type RejectionOperationResult,
} from './workflow/reject';
export { assertRespondable, assertResponseAccepted } from './workflow/respond';
export {
  describeAbandonOwner,
  type AbandonOwnerOutcome,
  type AbandonWorkflowResult,
} from './workflow/teardown';
export {
  AbandonOwnerNotStoppedError,
  AbandonRefusedError,
  describeReleasedWorktrees,
  type AbandonConversationRunsResult,
} from './workflow/abandon';
export {
  CancelRefusedError,
  type CancelRefusal,
  type CancelWorkflowResult,
} from './workflow/cancel';
export { ResumeRefusedError, type WorkflowStatusData } from './workflow/run-actions';

export interface WorkflowOperations {
  assertRunActionAllowed: (run: WorkflowRun, actor: RunActor, action: RunAction) => Promise<void>;
  listWorkflowRuns: IWorkflowStore['listWorkflowRuns'];
  findWorkflowRunsByIdPrefix: IWorkflowStore['findWorkflowRunsByIdPrefix'];
  signalWorkflowWait: (
    runId: string,
    request: SignalWorkflowWaitRequest,
    actor: RunActor
  ) => Promise<{ signaled: boolean }>;
  deleteWorkflowRun: (runId: string, actor: RunActor) => Promise<void>;
  getWorkflowStatus: (options?: { codebaseId?: string }) => Promise<WorkflowStatusData>;
  resumeWorkflow: (runId: string, actor: RunActor) => Promise<WorkflowRun>;
  abandonWorkflow: (
    runId: string,
    actor: RunActor
  ) => Promise<AbandonWorkflowResult & { owner: AbandonOwnerOutcome }>;
  cancelWorkflow: (runId: string, actor: RunActor) => Promise<CancelWorkflowResult>;
  abandonResumableRunsForConversation: (
    conversationId: string,
    actor: RunActor
  ) => Promise<AbandonConversationRunsResult>;
  approveWorkflow: (
    runId: string,
    comment: string | undefined,
    actor: RunActor,
    origin: GateAnswerOrigin
  ) => Promise<ApprovalOperationResult>;
  rejectWorkflow: (
    runId: string,
    reason: string | undefined,
    actor: RunActor,
    origin: GateAnswerOrigin
  ) => Promise<RejectionOperationResult>;
  respondToWorkflow: (
    runId: string,
    decision: string,
    text: string | undefined,
    actor: RunActor,
    origin: GateAnswerOrigin
  ) => Promise<ApprovalOperationResult | RejectionOperationResult>;
  answerWorkflow: (
    runId: string,
    request: AttentionAnswerRequest,
    actor: RunActor,
    origin: GateAnswerOrigin
  ) => Promise<AttentionAnswerOperationResult>;
  labelAttentionWait: (
    runId: string,
    request: AttentionLabelRequest,
    actor: RunActor,
    via: RecordSurface
  ) => Promise<AttentionLabelResult>;
  resetWorkflowNodeSessions: (
    filter: Parameters<IWorkflowStore['deleteWorkflowNodeSessions']>[0]
  ) => Promise<{ deleted: number }>;
}

export function createWorkflowOperations(deps: WorkflowOperationsDeps): WorkflowOperations {
  const ctx = createOperationContext(deps);
  return {
    listWorkflowRuns: options => deps.store.listWorkflowRuns(options),
    findWorkflowRunsByIdPrefix: (prefix, codebaseId) =>
      deps.store.findWorkflowRunsByIdPrefix(prefix, codebaseId),
    getWorkflowStatus: options => getWorkflowStatus(ctx, options),
    assertRunActionAllowed: ctx.assertMayAct,
    signalWorkflowWait: (runId, request, actor) => signalWorkflowWait(ctx, runId, request, actor),
    deleteWorkflowRun: (runId, actor) => deleteWorkflowRun(ctx, runId, actor),
    resumeWorkflow: (runId, actor) => resumeWorkflow(ctx, runId, actor),
    abandonWorkflow: (runId, actor) => abandonWorkflow(ctx, runId, actor),
    cancelWorkflow: (runId, actor) => cancelWorkflow(ctx, runId, actor),
    abandonResumableRunsForConversation: (conversationId, actor) =>
      abandonResumableRunsForConversation(ctx, conversationId, actor),
    approveWorkflow: (runId, comment, actor, origin) =>
      approveWorkflow(ctx, runId, comment, actor, origin),
    rejectWorkflow: (runId, reason, actor, origin) =>
      rejectWorkflow(ctx, runId, reason, actor, origin),
    respondToWorkflow: (runId, decision, text, actor, origin) =>
      respondToWorkflow(ctx, runId, decision, text, actor, origin),
    answerWorkflow: (runId, request, actor, origin) =>
      answerWorkflow(ctx, runId, request, actor, origin),
    labelAttentionWait: (runId, request, actor, via) =>
      labelAttentionWait(ctx, runId, request, actor, via),
    resetWorkflowNodeSessions: filter => resetWorkflowNodeSessions(ctx, filter),
  };
}
