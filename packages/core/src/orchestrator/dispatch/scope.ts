import * as sqlIsolation from '@archon/core/db/isolation-environments';
import type { RunModelOverrides } from '@archon/workflows/model-validation';
import type { prepareRunAiConfiguration } from '@archon/workflows/run-preflight';
import type { CapturedSourceOwner, PreparedWorkflowSource } from '@archon/workflows/run-source';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import type { ResolvedWorkflow, WorkflowSource } from '@archon/workflows/schemas/workflow';
import type { RunActor } from '../../operations/run-authorization';
import type {
  resolveRegisteredWorktree,
  resolveWorkflowAdoption,
} from '../../operations/workflow-adoption';
import type {
  Codebase,
  Conversation,
  HandleMessageContext,
  IPlatformAdapter,
  WorkflowRequest,
} from '../../types';
import { createCodebaseChildResolver } from '../../workflows/child-isolation-resolver';
import { createWorkflowDeps } from '../../workflows/store-adapter';

export interface WorkflowDispatchOptions {
  /**
   * Declared inputs supplied by the caller (#2554): the run route's
   * `HandleMessageContext.workflowInputs`, or the chat agent's `invoke_workflow` launch.
   * Validated at the dispatch gate before any worktree/clone/AI cost.
   */
  inputs?: Readonly<Record<string, string>>;
  /** Sparse tier/@alias rebindings supplied by this run invocation (#2481). */
  modelOverrides?: RunModelOverrides;
  /** Validated sparse config content supplied by a fresh HTTP invocation. */
  runConfig?: WorkflowRunConfigInput;
  /** Between-run continuation (#2747): adopt/supersede target, if declared. */
  adoptRunId?: string;
  supersedesRunId?: string;
}

/** The values one dispatch reads everywhere and nothing reassigns. */
export interface DispatchScope {
  readonly owner: CapturedSourceOwner;
  readonly platform: IPlatformAdapter;
  readonly conversationId: string;
  readonly conversation: Conversation;
  readonly codebase: Codebase;
  readonly actor: RunActor;
  readonly userId: string | undefined;
  readonly isolationHints: HandleMessageContext['isolationHints'] | undefined;
  readonly source: WorkflowSource | undefined;
  readonly options: WorkflowDispatchOptions | undefined;
  readonly userMessage: string;
  readonly parseWarnings: readonly string[] | undefined;
  readonly runCwd: string;
  readonly codebaseBaseBranch: string | undefined;
  readonly resolveChildIsolation: ReturnType<typeof createCodebaseChildResolver>;
}

export type CapturedSource = {
  preparedSource: PreparedWorkflowSource;
  workflow: ResolvedWorkflow;
};
export type DispatchAdoption = Awaited<ReturnType<typeof resolveWorkflowAdoption>>;
export type AdoptionLane = NonNullable<DispatchAdoption>['lane'];
export type AdoptedEnvironment = NonNullable<Awaited<ReturnType<typeof resolveRegisteredWorktree>>>;
export type PreparedAiConfiguration = Awaited<ReturnType<typeof prepareRunAiConfiguration>>;

export interface DispatchTarget {
  owner: CapturedSourceOwner;
  platform: IPlatformAdapter;
  conversationId: string;
  conversation: Conversation;
  codebase: Codebase;
  request: WorkflowRequest;
  actor: RunActor;
  isolationHints?: HandleMessageContext['isolationHints'];
  /**
   * Discovery source of the workflow — telemetry only (bundled workflows
   * report their real name, custom ones report "custom"). Optional: callers
   * that don't have it readily in scope omit it and the run reports "custom".
   */
  source?: WorkflowSource;
  options?: WorkflowDispatchOptions;
}

export function createDispatchScope(target: DispatchTarget): DispatchScope {
  const { owner, platform, conversationId, conversation, codebase, request, actor } = target;
  const userId = actor.kind === 'user' ? actor.userId : undefined;
  // The codebase's stored default branch — the $BASE_BRANCH fallback for every
  // executeWorkflow dispatch (repo config worktree.baseBranch still wins).
  const codebaseBaseBranch = codebase.default_branch?.trim() || undefined;
  return {
    owner,
    platform,
    conversationId,
    conversation,
    codebase,
    actor,
    userId,
    isolationHints: target.isolationHints,
    source: target.source,
    options: target.options,
    userMessage: request.kind === 'resume' ? request.run.user_message : request.args,
    parseWarnings: request.kind === 'start' ? request.parseWarnings : undefined,
    runCwd: conversation.cwd ?? codebase.default_cwd,
    codebaseBaseBranch,
    // Shared across every dispatch of this request.
    resolveChildIsolation: createCodebaseChildResolver(
      sqlIsolation.createIsolationStore(),
      codebase,
      {
        baseBranch: codebaseBaseBranch,
        createdByPlatform: platform.getPlatformType(),
        createdByUserId: userId,
      },
      createWorkflowDeps()
    ),
  };
}
