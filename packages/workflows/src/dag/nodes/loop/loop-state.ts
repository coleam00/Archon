import type {
  IAgentProvider,
  ProviderCapabilities,
  ProviderFailure,
  ResolvedModel,
  SendQueryOptions,
  TokenUsage,
} from '@archon/provider-contract';
import { finishNodeExecution } from '../../../node-execution';
import type { NodeExecutionResult } from '../../../node-record-serialization';
import type { NodeExecutionRecord, NodeFailureKind } from '../../../schemas/node-execution';
import { recordNodeState } from '../../../node-event-write';
import type { ApprovalContext, LoopNode } from '../../../schemas';
import type { AttemptEventSequence } from '../../../provider-events';
import type { getEffectiveNodeRetryConfig } from '../../retry';
import { getLog } from '../../log';
import type { RunLayersContext, SessionCheckpoint } from '../../run-context';

/** Where a loop node starts: fresh, or resuming the interactive gate it paused at. */
export interface LoopResume {
  /** The gate this node paused at, when this execution resumes one; undefined on a fresh start. */
  gate: ApprovalContext | undefined;
  startIteration: number;
  /** $LOOP_USER_INPUT for the first resumed iteration; '' otherwise. */
  userInput: string;
  feedbackGiven: boolean;
  iterationLimit: number;
  /** Usage consumed through the gate, which the resumed loop's totals start from. */
  costUsd: number | undefined;
  /** The gate recorded `costUsd` as complete; otherwise it is only a floor. A fresh start carries nothing in. */
  priorCostKnown: boolean;
  tokens: TokenUsage | undefined;
}

/** What one loop node execution holds fixed across its iterations. */
export interface LoopRun {
  ctx: RunLayersContext;
  node: LoopNode;
  /** Namespaced persisted step_name ('' prefix → node.id at top level, #2090). */
  stepName: string;
  msgContext: { workflowId: string; nodeName: string };
  workflowProvider: string;
  resolvedOptions: SendQueryOptions | undefined;
  aiClient: IAgentProvider;
  capabilities: ProviderCapabilities;
  iterationEnv: Record<string, string>;
  /** Iterations share the loop's attempt, so they share its provider-event sequence. */
  attemptEvents: AttemptEventSequence;
  promptTemplate: string;
  resume: LoopResume;
  retryConfig: ReturnType<typeof getEffectiveNodeRetryConfig>;
  checkpointSession: SessionCheckpoint | undefined;
}

/** What a loop node accumulates across iterations; its failure, gate and completion records read it. */
export interface LoopState {
  execution: NodeExecutionRecord;
  lastStartedIteration: number;
  sessionId: string | undefined;
  stopReason: string | undefined;
  numTurns: number | undefined;
  /**
   * Concrete model the provider resolved to (#2314). Last-seen wins, like stopReason:
   * every iteration runs on the same resolved provider and model, so the final
   * iteration's report is the node's report.
   */
  resolvedModel: ResolvedModel | undefined;
  costUsd: number | undefined;
  /** The gate recorded the cost it carried in as complete; otherwise `costUsd` is only a floor. */
  priorCostKnown: boolean;
  tokens: TokenUsage | undefined;
  tokensUnknown: boolean;
  /**
   * The previous iteration's output: $LOOP_PREV_OUTPUT, until_bash's LOOP_PREV_OUTPUT and,
   * after the loop ends, the node's output.
   */
  lastOutput: string;
  lastStructuredOutput: unknown;
  /**
   * Union of task ids still live when ANY iteration's stream ended abnormally
   * (idle timeout / operator cutoff / subprocess death) — #2083. Union rather than last-iteration:
   * a mid-loop iteration that lost its background tasks may have produced
   * incomplete artifacts even when a later iteration finishes cleanly and
   * signals completion — last-iteration-only reporting would hide that.
   * Recorded on the node_completed event so an incomplete node never
   * masquerades as a clean success (mirrors the AI-node path in
   * executeAgentNode).
   */
  backgroundTasksIncomplete: Set<string>;
}

export interface LoopFailureExtras {
  failureKind: NodeFailureKind;
  providerFailure?: ProviderFailure;
  output?: string;
  costUsd?: number;
  tokens?: TokenUsage;
  tokensUnknown?: boolean;
  loopIterations?: number;
  data?: Pick<
    NonNullable<NodeExecutionRecord['diagnostics']>,
    'command' | 'iteration' | 'status' | 'maxIterations'
  >;
}

export async function failLoopNode(
  ctx: RunLayersContext,
  nodeId: string,
  state: LoopState,
  error: string,
  extras: LoopFailureExtras
): Promise<NodeExecutionResult> {
  getLog().error({ nodeId, error, ...extras.data }, 'loop_node.failed');
  const { execution } = state;
  return recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    finishNodeExecution(
      execution,
      {
        status: 'failed',
        error,
        failureKind: extras.failureKind,
        ...(extras.providerFailure !== undefined
          ? { providerFailure: extras.providerFailure }
          : {}),
      },
      {
        output: { text: extras.output ?? '' },
        tokens: extras.tokens,
        tokensUnknown:
          (execution.spend.tokens.source === 'unavailable' &&
            execution.spend.tokens.reason === 'incomplete') ||
          extras.tokensUnknown,
        costUsd: extras.costUsd,
        costPartial: !state.priorCostKnown,
        stopReason: state.stopReason,
        numTurns: state.numTurns,
        resolvedModel: state.resolvedModel?.id,
        sessionId: state.sessionId,
        diagnostics: { ...extras.data, loopIterations: extras.loopIterations },
      }
    )
  );
}

/** The usage the loop has consumed so far, as a failure record reports it. */
export function loopSpend(
  state: LoopState
): Pick<LoopFailureExtras, 'costUsd' | 'tokens' | 'tokensUnknown'> {
  return {
    costUsd: state.costUsd,
    ...(state.tokens !== undefined ? { tokens: state.tokens } : {}),
    ...(state.tokensUnknown ? { tokensUnknown: true } : {}),
  };
}

export function logIterationEventError(nodeId: string, err: Error, iteration: number): void {
  getLog().error({ err, nodeId, iteration }, 'loop_node.iteration_event_failed');
}
