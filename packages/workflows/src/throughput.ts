import { readNodeRecordEvent, type NodeRecordEventEnvelope } from './node-record-reader';
import type { NodeExecutionMetadata } from './schemas/node-execution';
import { nodeCostScope, NODE_EXECUTION_EVENT_TYPES } from './node-record-serialization';

export const THROUGHPUT_EVENT_TYPES = [
  NODE_EXECUTION_EVENT_TYPES.completed,
  NODE_EXECUTION_EVENT_TYPES.failed,
  NODE_EXECUTION_EVENT_TYPES.suspended,
] as const;

export interface ThroughputSummary {
  outputTokens: number;
  durationMs: number;
  measuredExecutions: number;
  nodesWithoutTokenData: number;
  nodesWithoutDuration: number;
  loopNodesNotMeasured: number;
  effectiveTokensPerSecond: number | null;
}

type Sample =
  | { exclusion: null; outputTokens: number; durationMs: number; effectiveTokensPerSecond: number }
  | { exclusion: 'tokens' | 'duration' | 'loop'; effectiveTokensPerSecond: null };

export type NodeThroughput = {
  path: string;
  invocation: NodeExecutionMetadata['invocation'] | null;
  attempt: NodeExecutionMetadata['attempt'] | null;
  provider: string | null;
  requestedModel: string | null;
} & Sample;

export interface RunThroughput {
  runId: string;
  nodes: NodeThroughput[];
  summary: ThroughputSummary;
}

export interface ModelThroughput extends ThroughputSummary {
  provider: NodeThroughput['provider'];
  requestedModel: NodeThroughput['requestedModel'];
}

function summarize(nodes: readonly NodeThroughput[]): ThroughputSummary {
  let outputTokens = 0;
  let durationMs = 0;
  let measuredExecutions = 0;
  let nodesWithoutTokenData = 0;
  let nodesWithoutDuration = 0;
  let loopNodesNotMeasured = 0;
  for (const node of nodes) {
    if (node.exclusion === null) {
      outputTokens += node.outputTokens;
      durationMs += node.durationMs;
      measuredExecutions++;
    } else if (node.exclusion === 'tokens') nodesWithoutTokenData++;
    else if (node.exclusion === 'duration') nodesWithoutDuration++;
    else loopNodesNotMeasured++;
  }
  return {
    outputTokens,
    durationMs,
    measuredExecutions,
    nodesWithoutTokenData,
    nodesWithoutDuration,
    loopNodesNotMeasured,
    effectiveTokensPerSecond: measuredExecutions === 0 ? null : (outputTokens / durationMs) * 1000,
  };
}

function sample(metadata: NodeExecutionMetadata | undefined): Sample {
  const tokens = metadata?.spend.tokens;
  if (
    tokens?.source !== 'provider' ||
    !Number.isInteger(tokens.value.output) ||
    tokens.value.output < 0
  ) {
    return { exclusion: 'tokens', effectiveTokensPerSecond: null };
  }
  const durationMs = metadata?.timing.durationMs;
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) {
    return { exclusion: 'duration', effectiveTokensPerSecond: null };
  }
  return {
    exclusion: null,
    outputTokens: tokens.value.output,
    durationMs,
    effectiveTokensPerSecond: (tokens.value.output / durationMs) * 1000,
  };
}

function nodeThroughput(event: NodeRecordEventEnvelope): NodeThroughput | null {
  if (!THROUGHPUT_EVENT_TYPES.some(type => type === event.event_type)) return null;
  const record = readNodeRecordEvent(event);
  if (!record) return null;
  const metadata = record.metadata;
  const kind = metadata?.node.kind ?? record.data.type;
  if (event.event_type === NODE_EXECUTION_EVENT_TYPES.suspended && kind !== 'loop') return null;
  if ((kind !== 'agent' && kind !== 'loop') || nodeCostScope(record.data) !== 'own') return null;
  const binding = metadata?.binding ?? {
    provider: record.data.provider,
    model: { requested: record.data.model_usage?.requested ?? record.data.model },
  };
  return {
    path: record.path,
    invocation: metadata?.invocation ?? null,
    attempt: metadata?.attempt ?? null,
    provider: binding.provider ?? null,
    requestedModel: binding.model?.requested ?? null,
    // Loop descriptors do not record whether their duration includes an approval pause.
    ...(kind === 'loop'
      ? { exclusion: 'loop' as const, effectiveTokensPerSecond: null }
      : sample(metadata)),
  };
}

/** Own agent terminal attempts and loop work: wrappers and amendments restate work. */
export function runThroughput(
  runId: string,
  events: readonly NodeRecordEventEnvelope[]
): RunThroughput {
  const nodes: NodeThroughput[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.workflow_run_id !== runId) continue;
    const node = nodeThroughput(event);
    if (!node) continue;
    if (node.attempt) {
      if (seen.has(node.attempt.id)) continue;
      seen.add(node.attempt.id);
    }
    nodes.push(node);
  }
  return { runId, nodes, summary: summarize(nodes) };
}

export function throughputAcrossRuns(runs: readonly RunThroughput[]): {
  runIds: string[];
  runCount: number;
  models: ModelThroughput[];
} {
  const groups = new Map<
    string,
    {
      provider: NodeThroughput['provider'];
      requestedModel: NodeThroughput['requestedModel'];
      nodes: NodeThroughput[];
    }
  >();
  for (const run of runs)
    for (const node of run.nodes) {
      const key = JSON.stringify([node.provider, node.requestedModel]);
      const group = groups.get(key) ?? {
        provider: node.provider,
        requestedModel: node.requestedModel,
        nodes: [],
      };
      group.nodes.push(node);
      groups.set(key, group);
    }
  return {
    runIds: runs.map(run => run.runId),
    runCount: runs.length,
    models: [...groups.values()].map(({ provider, requestedModel, nodes }) => ({
      provider,
      requestedModel,
      ...summarize(nodes),
    })),
  };
}
