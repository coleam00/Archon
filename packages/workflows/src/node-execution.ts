import { randomUUID } from 'node:crypto';
import type { ProviderCapabilities, TokenUsage } from '@archon/provider-contract';
import type { DagNode } from './schemas/dag-node';
import type { EffortLevel } from './schemas/effort';
import type { TierName } from './schemas/model-binding';
import type { CheckoutObservation } from './schemas/checkout-observation';
import { sessionPreview, tokenUsageSchema } from '@archon/provider-contract';
import {
  nodeExecutionMetadataSchema,
  type ExecutionBinding,
  type ExecutionOutput,
  type NodeDescriptor,
  type NodeExecutionMetadata,
  type NodeExecutionRecord,
  type NodeInvocation,
} from './schemas/node-execution';

export function describeExecutionNode(node: DagNode): NodeDescriptor {
  const { id, kind } = node;
  switch (kind) {
    case 'agent':
      return {
        id,
        kind,
        source:
          node.source.kind === 'command'
            ? { kind: 'command', name: node.source.name }
            : { kind: 'inline' },
      };
    case 'exec':
      return { id, kind, runtime: node.runtime };
    case 'loop':
      return { id, kind, ...(node.loop.command ? { command: node.loop.command } : {}) };
    case 'workflow':
      return { id, kind, ...(node.fan_out !== undefined ? { fanOut: true } : {}) };
    default:
      return { id, kind };
  }
}

export function newNodeInvocation(
  loopPath: NodeInvocation['loopPath'] = [],
  now = new Date().toISOString()
): NodeInvocation {
  return { id: randomUUID(), startedAt: now, loopPath };
}

type Measurement<T> =
  | (Omit<Extract<NodeExecutionRecord['spend']['tokens'], { source: 'provider' }>, 'value'> & {
      value: T;
    })
  | Extract<NodeExecutionRecord['spend']['tokens'], { source: 'unavailable' }>;

function measurement<T>(
  value: T | undefined,
  supported: boolean | undefined,
  provider: boolean
): Measurement<T> {
  if (value !== undefined) return { source: 'provider' as const, value };
  return {
    source: 'unavailable' as const,
    reason: !provider
      ? ('not_applicable' as const)
      : supported === false
        ? ('unsupported' as const)
        : supported === true
          ? ('not_reported' as const)
          : ('unknown' as const),
  };
}

function defaultNodeAccounting(node: NodeDescriptor): NodeExecutionRecord['accounting'] {
  switch (node.kind) {
    case 'compose_fan_out_instance':
      return 'instance';
    case 'loop_group':
    case 'compose_fan_out':
      return 'aggregate';
    default:
      return 'node';
  }
}

export function startNodeExecution(input: {
  runId: string;
  path: string;
  node: DagNode | Extract<NodeDescriptor, { kind: 'compose_fan_out_instance' }>;
  invocation: NodeInvocation;
  provider?: string;
  model?: string;
  tier?: TierName;
  effort?: EffortLevel;
  capabilities?: ProviderCapabilities;
  sessionId?: string;
  accounting?: NodeExecutionRecord['accounting'];
  /** This attempt's checkout sample; the invocation keeps its own first sample. */
  checkoutStart?: CheckoutObservation;
  now?: string;
}): NodeExecutionRecord {
  const now = input.now ?? new Date().toISOString();
  const node =
    input.node.kind === 'compose_fan_out_instance' ? input.node : describeExecutionNode(input.node);
  const hasProvider = input.provider !== undefined;
  const caps = input.capabilities;
  return {
    runId: input.runId,
    path: input.path,
    node,
    invocation: input.invocation,
    attempt: {
      id: randomUUID(),
      startedAt: now,
      ...(input.checkoutStart !== undefined ? { checkoutStart: input.checkoutStart } : {}),
    },
    binding: {
      ...(input.provider ? { provider: input.provider } : {}),
      ...(hasProvider
        ? {
            model: {
              ...(input.model !== undefined ? { requested: input.model } : {}),
              resolved: measurement<string>(undefined, caps?.resolvedModelReporting, true),
            },
          }
        : {}),
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.sessionId !== undefined
        ? {
            sessionPreview: sessionPreview(input.sessionId),
            sessionOrigin: 'resumed' as const,
          }
        : hasProvider
          ? { sessionOrigin: 'fresh' as const }
          : {}),
    },
    timing: { startedAt: now },
    spend: {
      tokens: measurement<TokenUsage>(undefined, caps?.tokenReporting, hasProvider),
      costUsd: measurement<number>(undefined, caps?.costReporting, hasProvider),
      stopReason: measurement<string>(undefined, caps?.stopReasonReporting, hasProvider),
      numTurns: measurement<number>(undefined, caps?.turnCountReporting, hasProvider),
    },
    accounting: input.accounting ?? defaultNodeAccounting(node),
    lifecycle: { status: 'started' },
  };
}

export interface ExecutionObservations {
  tokensUnknown?: boolean;
  tokens?: TokenUsage;
  costUsd?: number;
  /** Some provider call in the attempt reported no cost, so `costUsd` is a floor. */
  costPartial?: boolean;
  stopReason?: string;
  numTurns?: number;
  resolvedModel?: string;
}

/** Close or suspend a captured start; omitted observations never become zero. */
export function finishNodeExecution(
  start: NodeExecutionRecord,
  lifecycle: Exclude<NodeExecutionRecord['lifecycle'], { status: 'started' }>,
  result: ExecutionObservations & {
    output?: ExecutionOutput;
    diagnostics?: NodeExecutionRecord['diagnostics'];
    sessionId?: string;
    resumed?: boolean;
    durationMs?: number;
    /** The attempt ended before any provider call, so it has no spend to measure. */
    providerNotCalled?: boolean;
  } = {}
): NodeExecutionRecord {
  const observed = <T>(
    value: T | undefined,
    previous: Measurement<T>,
    valid: (candidate: T) => boolean = () => true
  ): Measurement<T> =>
    value === undefined
      ? previous
      : valid(value)
        ? { source: 'provider' as const, value }
        : { source: 'unavailable' as const, reason: 'invalid' as const };
  const binding: ExecutionBinding = {
    ...start.binding,
    ...(start.binding.model
      ? {
          model: {
            ...start.binding.model,
            resolved: observed(result.resolvedModel, start.binding.model.resolved),
          },
        }
      : {}),
    ...(result.sessionId ? { sessionPreview: sessionPreview(result.sessionId) } : {}),
    ...(result.resumed !== undefined
      ? {
          sessionOrigin: result.resumed ? ('resumed' as const) : ('resume-failed-cold' as const),
        }
      : {}),
  };
  return {
    ...start,
    binding,
    lifecycle,
    timing: {
      startedAt: start.timing.startedAt,
      durationMs: result.durationMs ?? Math.max(0, Date.now() - Date.parse(start.timing.startedAt)),
    },
    spend: result.providerNotCalled
      ? {
          tokens: NOT_APPLICABLE,
          costUsd: NOT_APPLICABLE,
          stopReason: NOT_APPLICABLE,
          numTurns: NOT_APPLICABLE,
        }
      : {
          tokens: result.tokensUnknown
            ? { source: 'unavailable', reason: 'incomplete' }
            : observed(
                result.tokens,
                start.spend.tokens,
                value => tokenUsageSchema.safeParse(value).success
              ),
          costUsd: withCostPartial(
            observed(result.costUsd, start.spend.costUsd, Number.isFinite),
            result.costPartial === true
          ),
          stopReason: observed(result.stopReason, start.spend.stopReason),
          numTurns: observed(result.numTurns, start.spend.numTurns, Number.isFinite),
        },
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.diagnostics !== undefined ? { diagnostics: result.diagnostics } : {}),
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
  };
}

const NOT_APPLICABLE = { source: 'unavailable', reason: 'not_applicable' } as const;

type CostMeasurement = NodeExecutionRecord['spend']['costUsd'];

function withCostPartial(cost: CostMeasurement, partial: boolean): CostMeasurement {
  return partial && cost.source === 'provider' ? { ...cost, partial: true } : cost;
}

/** Excludes output bodies and diagnostics from the shared public execution facts. */
export function executionMetadata(record: NodeExecutionRecord): NodeExecutionMetadata {
  return nodeExecutionMetadataSchema.parse(record);
}
