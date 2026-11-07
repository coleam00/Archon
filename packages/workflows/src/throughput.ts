import { readNodeRecordEvent, type NodeRecordEventEnvelope } from './node-record-reader';
import type { NodeExecutionMetadata } from './schemas/node-execution';
import { NODE_EXECUTION_EVENT_TYPES } from './node-record-serialization';

export const THROUGHPUT_EVENT_TYPES = [
  NODE_EXECUTION_EVENT_TYPES.completed,
  NODE_EXECUTION_EVENT_TYPES.failed,
] as const;

export interface ThroughputSummary {
  outputTokens: number;
  durationMs: number;
  measuredExecutions: number;
  nodesWithoutTokenData: number;
  nodesWithoutDuration: number;
  effectiveTokensPerSecond: number | null;
}

type Sample =
  | { exclusion: null; outputTokens: number; durationMs: number; effectiveTokensPerSecond: number }
  | { exclusion: 'tokens' | 'duration'; effectiveTokensPerSecond: null };

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
  for (const node of nodes) {
    if (node.exclusion === null) {
      outputTokens += node.outputTokens;
      durationMs += node.durationMs;
      measuredExecutions++;
    } else if (node.exclusion === 'tokens') nodesWithoutTokenData++;
    else nodesWithoutDuration++;
  }
  return {
    outputTokens,
    durationMs,
    measuredExecutions,
    nodesWithoutTokenData,
    nodesWithoutDuration,
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
  if (
    metadata
      ? metadata.node.kind !== 'agent' || metadata.accounting !== 'node'
      : record.data.type !== 'agent'
  )
    return null;
  return {
    path: record.path,
    invocation: metadata?.invocation ?? null,
    attempt: metadata?.attempt ?? null,
    provider: metadata?.binding.provider ?? null,
    requestedModel: metadata?.binding.model?.requested ?? null,
    ...sample(metadata),
  };
}

/** Own terminal attempts only: wrappers and amendments restate already recorded work. */
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
