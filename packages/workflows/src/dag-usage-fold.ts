import { createLogger } from '@archon/paths';
import { mergeTokenUsage, modelCallUsageSchema, type TokenUsage } from '@archon/provider-contract';
import { sumFanOutTokens, sumReportedCost } from './dag/usage';
import {
  readDeferredNodeUsageEvent,
  readNodeRecordEvent,
  type ReadNodeRecordEvent,
} from './node-record-reader';
import {
  nodeCostScope,
  DEFERRED_NODE_USAGE_EVENT_TYPE,
  isPersistedExecType,
} from './node-record-serialization';
import {
  nodeDescriptorSchema,
  type NodeDescriptor,
  type NodeExecutionMetadata,
  type NodeInvocation,
} from './schemas/node-execution';
import { attemptSpend } from './run-budget';
import { NODE_STATE_EVENT_TYPES, type DagResumeSnapshot } from './store';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  return (cachedLog ??= createLogger('workflow.dag-usage-fold'));
}

export interface DagUsageRow {
  step_name: string;
  event_type: string;
  data?: string | Record<string, unknown>;
}

export interface DagUsageMeasurement {
  tokens:
    | (Omit<Extract<NodeExecutionMetadata['spend']['tokens'], { source: 'provider' }>, 'value'> & {
        value: Pick<TokenUsage, 'input' | 'output' | 'cachePartial' | 'callsPartial'>;
      })
    | Extract<NodeExecutionMetadata['spend']['tokens'], { source: 'unavailable' }>;
  costUsd: NodeExecutionMetadata['spend']['costUsd'];
}

export interface DagUsageObservation {
  path: string;
  eventType: ReadNodeRecordEvent['eventType'] | typeof DEFERRED_NODE_USAGE_EVENT_TYPE;
  nodeKind?: NodeDescriptor['kind'];
  provider?: string;
  invocationId?: string;
  loopPath?: NodeInvocation['loopPath'];
  attemptId?: string;
  measurement?: DagUsageMeasurement;
  accounting?: NodeExecutionMetadata['accounting'];
  skipReason?: ReadNodeRecordEvent['data']['reason'];
}

export interface DagUsageFold {
  readonly runId: string;
  usageContributions: UsageContribution[];
  readonly observations: DagUsageObservation[];
  readonly reportedChildUsage: NonNullable<DagResumeSnapshot['reportedChildUsage']>;
  readonly childUsagePaths: Map<string, Set<string>>;
  readonly opaqueChildUsagePaths: Map<string, Set<string>>;
  readonly unattributedChildUsagePaths: Set<string>;
  readonly latestNodeKindByPath: Map<string, NodeDescriptor['kind']>;
}

export function newDagUsageFold(runId: string): DagUsageFold {
  return {
    runId,
    usageContributions: [],
    observations: [],
    reportedChildUsage: new Map(),
    childUsagePaths: new Map(),
    opaqueChildUsagePaths: new Map(),
    unattributedChildUsagePaths: new Set(),
    latestNodeKindByPath: new Map(),
  };
}

function projectUsageMeasurement(spend: NodeExecutionMetadata['spend']): DagUsageMeasurement {
  const tokens = spend.tokens;
  return {
    tokens:
      tokens.source === 'unavailable'
        ? { ...tokens }
        : {
            source: tokens.source,
            value: {
              input: tokens.value.input,
              output: tokens.value.output,
              ...(tokens.value.cachePartial === undefined
                ? {}
                : { cachePartial: tokens.value.cachePartial }),
              ...(tokens.value.callsPartial === undefined
                ? {}
                : { callsPartial: tokens.value.callsPartial }),
            },
          },
    costUsd: { ...spend.costUsd },
  };
}

function projectUsageObservation(record: ReadNodeRecordEvent): DagUsageObservation {
  const metadata = record.metadata;
  const nodeKind = metadata?.node.kind ?? recordedNodeKind(record.data.type);
  return {
    path: record.path,
    eventType: record.eventType,
    ...(nodeKind === undefined ? {} : { nodeKind }),
    ...(record.data.provider === undefined ? {} : { provider: record.data.provider }),
    ...(metadata === undefined
      ? {}
      : {
          nodeKind: metadata.node.kind,
          ...(metadata.binding.provider === undefined
            ? {}
            : { provider: metadata.binding.provider }),
          invocationId: metadata.invocation.id,
          loopPath: metadata.invocation.loopPath.map(frame => ({ ...frame })),
          attemptId: metadata.attempt.id,
          measurement: projectUsageMeasurement(metadata.spend),
          accounting: metadata.accounting,
        }),
    ...(record.data.reason === undefined ? {} : { skipReason: record.data.reason }),
  };
}

function recordedNodeKind(type: string | undefined): NodeDescriptor['kind'] | undefined {
  if (isPersistedExecType(type)) return 'exec';
  return nodeDescriptorSchema.options.find(option => option.shape.kind.value === type)?.shape.kind
    .value;
}

function recordChildUsagePath(fold: DagUsageFold, childRunId: string, path: string): void {
  fold.opaqueChildUsagePaths.delete(childRunId);
  const paths = fold.childUsagePaths.get(childRunId) ?? new Set<string>();
  paths.add(path);
  fold.childUsagePaths.set(childRunId, paths);
}

function recordObservation(fold: DagUsageFold, evidence: DagUsageObservation): void {
  fold.observations.push(evidence);
  if (evidence.nodeKind === undefined) fold.latestNodeKindByPath.delete(evidence.path);
  else fold.latestNodeKindByPath.set(evidence.path, evidence.nodeKind);
}

export function foldDagUsageRecord(
  fold: DagUsageFold,
  row: DagUsageRow,
  record: ReadNodeRecordEvent
): void {
  const evidence = projectUsageObservation(record);
  recordObservation(fold, evidence);
  if (
    row.event_type !== 'node_completed' &&
    row.event_type !== 'node_failed' &&
    row.event_type !== 'node_skipped_prior_success'
  )
    return;
  if (row.event_type !== 'node_skipped_prior_success') foldChildUsage(fold, record);
  foldNodeUsage(fold, row, record, evidence);
}

export function foldDagUsage(
  rows: readonly {
    step_name?: string | null;
    event_type: string;
    data?: string | Record<string, unknown>;
  }[],
  runId: string
): DagUsageFold {
  const fold = newDagUsageFold(runId);
  for (const row of rows) {
    if (!row.step_name) continue;
    const usageRow = { ...row, step_name: row.step_name };
    if (row.event_type === DEFERRED_NODE_USAGE_EVENT_TYPE) {
      foldDeferredUsage(fold, usageRow);
    } else if (NODE_STATE_EVENT_TYPES.some(type => type === row.event_type)) {
      const record = readNodeRecordEvent({
        workflow_run_id: runId,
        ...usageRow,
        data: usageRow.data,
      });
      if (record !== undefined) foldDagUsageRecord(fold, usageRow, record);
    }
  }
  return fold;
}

export interface UsageContribution {
  stepName: string;
  evidence?: DagUsageObservation;
  coveredContributions?: readonly UsageContribution[];
  loopBaseline?: Pick<NodeExecutionMetadata, 'invocation' | 'spend'>;
  tokens?: TokenUsage;
  tokensUnknown?: boolean;
  costUsd?: number;
  costPartial?: boolean;
}

function isReportedTokens(
  value: unknown
): value is { input: number; output: number } & Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'input' in value &&
    'output' in value &&
    typeof value.input === 'number' &&
    typeof value.output === 'number' &&
    Number.isFinite(value.input) &&
    Number.isFinite(value.output)
  );
}

function readTokens(runId: string, stepName: string, tokens: unknown): TokenUsage | undefined {
  if (!isReportedTokens(tokens)) {
    getLog().warn({ runId, stepName, tokens }, 'db.workflow_dag_node_tokens_invalid_ignored');
    return undefined;
  }
  const normalized: TokenUsage = { input: tokens.input, output: tokens.output };
  for (const axis of ['cacheRead', 'cacheWrite'] as const) {
    const value = tokens[axis];
    if (value === undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      normalized[axis] = value;
    } else {
      getLog().warn(
        { runId, stepName, axis, value },
        'db.workflow_dag_node_optional_tokens_invalid_ignored'
      );
    }
  }
  // A node whose own usage was already a floor (a loop total, an OpenCode
  // multi-agent node) keeps the resumed run a floor. Anything other than `true`
  // is ignored without a warn: unlike the numeric axes it carries no total.
  if (tokens.cachePartial === true) normalized.cachePartial = true;
  if (tokens.callsPartial === true) normalized.callsPartial = true;
  // The record reader already replaced an unreadable `calls` with `callsPartial`.
  const calls = modelCallUsageSchema.array().safeParse(tokens.calls);
  if (calls.success) normalized.calls = calls.data;
  return normalized;
}

function readCost(runId: string, stepName: string, costUsd: unknown): number | undefined {
  // Same guard shape as tokens: a non-finite value from a provider must not
  // silently poison the total (NaN > 0 is false, which would drop the run's
  // cost from the persisted metadata with no trace).
  if (typeof costUsd === 'number' && Number.isFinite(costUsd)) return costUsd;
  getLog().warn({ runId, stepName, costUsd }, 'db.workflow_dag_node_cost_invalid_ignored');
  return undefined;
}

function readUsage(
  fold: DagUsageFold,
  stepName: string,
  rawUsage: ReadNodeRecordEvent['rawUsage'],
  execution?: Pick<NodeExecutionMetadata, 'spend'>,
  evidence?: DagUsageObservation
): UsageContribution {
  const costPartial =
    execution !== undefined
      ? attemptSpend(execution).kind === 'unavailable'
      : rawUsage.costPartial === true;
  const contribution: UsageContribution = {
    stepName,
    ...(evidence === undefined ? {} : { evidence }),
    ...(costPartial ? { costPartial: true } : {}),
    ...(rawUsage.tokensUnknown ? { tokensUnknown: true } : {}),
  };
  if (rawUsage.tokens !== undefined) {
    const tokens = readTokens(fold.runId, stepName, rawUsage.tokens);
    if (tokens !== undefined) contribution.tokens = tokens;
    else contribution.tokensUnknown = true;
  }
  if (rawUsage.costUsd !== undefined) {
    const costUsd = readCost(fold.runId, stepName, rawUsage.costUsd);
    if (costUsd !== undefined) contribution.costUsd = costUsd;
  }
  return contribution;
}

function addUsage(
  fold: DagUsageFold,
  stepName: string,
  rawUsage: ReadNodeRecordEvent['rawUsage'],
  execution?: Pick<NodeExecutionMetadata, 'spend'>,
  evidence?: DagUsageObservation
): void {
  const contribution = readUsage(fold, stepName, rawUsage, execution, evidence);
  if (
    contribution.costPartial ||
    contribution.tokensUnknown ||
    contribution.tokens !== undefined ||
    contribution.costUsd !== undefined
  ) {
    fold.usageContributions.push(contribution);
  }
}

export function foldDeferredUsage(fold: DagUsageFold, row: DagUsageRow): void {
  let usage: ReturnType<typeof readDeferredNodeUsageEvent>;
  try {
    usage = readDeferredNodeUsageEvent({ workflow_run_id: fold.runId, ...row, data: row.data });
  } catch (parseErr) {
    throw new Error(`Invalid deferred usage record for '${row.step_name}' in run ${fold.runId}`, {
      cause: parseErr,
    });
  }
  if (!usage || nodeCostScope(usage.data) === 'total') return;
  const evidence = projectDeferredUsageObservation(fold, usage);
  recordObservation(fold, evidence);
  foldDeferredLoopBaseline(fold, usage, evidence);
  addUsage(
    fold,
    row.step_name,
    usage.rawUsage,
    usage.data.spend === undefined ? undefined : { spend: usage.data.spend },
    evidence
  );
}

function projectDeferredUsageObservation(
  fold: DagUsageFold,
  usage: NonNullable<ReturnType<typeof readDeferredNodeUsageEvent>>
): DagUsageObservation {
  const priorNodeKind = fold.latestNodeKindByPath.get(usage.path);
  return {
    path: usage.path,
    eventType: DEFERRED_NODE_USAGE_EVENT_TYPE,
    ...(priorNodeKind === undefined ? {} : { nodeKind: priorNodeKind }),
    ...(usage.data.invocation === undefined
      ? {}
      : {
          invocationId: usage.data.invocation.id,
          loopPath: usage.data.invocation.loopPath.map(frame => ({ ...frame })),
        }),
    ...(usage.data.spend === undefined
      ? {}
      : { measurement: projectUsageMeasurement(usage.data.spend) }),
  };
}

function foldDeferredLoopBaseline(
  fold: DagUsageFold,
  usage: NonNullable<ReturnType<typeof readDeferredNodeUsageEvent>>,
  evidence: DagUsageObservation
): void {
  if (usage.data.loopBaseline !== undefined && usage.data.invocation !== undefined) {
    replaceLoopBaseline(fold, usage.path, usage.data.invocation.id);
    const spend = usage.data.loopBaseline;
    const baseline = readUsage(
      fold,
      usage.path,
      {
        tokens: spend.tokens.source === 'provider' ? spend.tokens.value : undefined,
        tokensUnknown:
          spend.tokens.source === 'unavailable' && spend.tokens.reason === 'incomplete',
        costUsd: spend.costUsd.source === 'provider' ? spend.costUsd.value : undefined,
      },
      { spend },
      { ...evidence, measurement: projectUsageMeasurement(spend) }
    );
    baseline.loopBaseline = { invocation: usage.data.invocation, spend: usage.data.loopBaseline };
    fold.usageContributions.push(baseline);
  } else {
    replaceLoopBaseline(fold, usage.path, usage.data.invocation?.id);
  }
}

// Configuration failures and interrupted continuations can report carried gate spend.
// A later cumulative report replaces that baseline, leaving paid interrupted attempts.
function replaceLoopBaseline(
  fold: DagUsageFold,
  stepName: string,
  invocationId: string | undefined
): void {
  if (invocationId === undefined) return;
  fold.usageContributions = fold.usageContributions.filter(
    contribution =>
      contribution.stepName !== stepName ||
      contribution.loopBaseline?.invocation.id !== invocationId
  );
}

function replaceInstanceSegment(
  fold: DagUsageFold,
  stepName: string
): readonly UsageContribution[] {
  const prefix = `${stepName}__`;
  for (const [childRunId, paths] of fold.childUsagePaths) {
    const replaced = [...paths].filter(path => path.startsWith(prefix));
    if (replaced.length > 0) fold.opaqueChildUsagePaths.set(childRunId, new Set(replaced));
  }
  const covered = fold.usageContributions.filter(contribution =>
    contribution.stepName.startsWith(prefix)
  );
  fold.usageContributions = fold.usageContributions.filter(
    contribution => !contribution.stepName.startsWith(prefix)
  );
  return covered;
}

function foldNodeUsage(
  fold: DagUsageFold,
  row: DagUsageRow,
  record: ReadNodeRecordEvent,
  evidence: DagUsageObservation
): void {
  // Each instance terminal owns only the preceding segment. Later inner rows
  // remain counted until a subsequent terminal replaces that segment.
  const isAuthoritativeInstanceUsage =
    record.data.type === 'compose_fan_out_instance' &&
    (row.event_type === 'node_completed' || row.event_type === 'node_failed');
  const coveredContributions = isAuthoritativeInstanceUsage
    ? replaceInstanceSegment(fold, row.step_name)
    : undefined;
  // Other aggregate rows merely restate usage already carried by their leaves.
  if (nodeCostScope(record.data) === 'total' && !isAuthoritativeInstanceUsage) return;
  if (row.event_type !== 'node_skipped_prior_success') {
    const metadata = record.metadata;
    if (metadata?.node.kind === 'loop') {
      replaceLoopBaseline(fold, row.step_name, metadata.invocation.id);
      const contribution = readUsage(fold, row.step_name, record.rawUsage, metadata, evidence);
      if (metadata.lifecycle.status === 'failed' && metadata.lifecycle.failureKind === 'config') {
        contribution.loopBaseline = metadata;
      }
      fold.usageContributions.push(contribution);
    } else {
      addNodeUsage(fold, record, evidence, coveredContributions);
    }
  }
}

function addNodeUsage(
  fold: DagUsageFold,
  record: ReadNodeRecordEvent,
  evidence: DagUsageObservation,
  coveredContributions: readonly UsageContribution[] | undefined
): void {
  const before = fold.usageContributions.length;
  addUsage(fold, record.path, record.rawUsage, record.metadata, evidence);
  if (coveredContributions !== undefined && fold.usageContributions.length > before) {
    fold.usageContributions[before].coveredContributions = coveredContributions;
  }
}

function foldReportedChildUsage(
  fold: DagUsageFold,
  usages: NonNullable<ReadNodeRecordEvent['data']['child_usage']>
): void {
  for (const usage of usages) {
    const prior = fold.reportedChildUsage.get(usage.childRunId);
    const hasTokenMeasurement = usage.tokens !== undefined || usage.tokensUnknown === true;
    fold.reportedChildUsage.set(usage.childRunId, {
      ...usage,
      costUsd: usage.costUsd ?? prior?.costUsd,
      tokens:
        usage.tokens !== undefined
          ? { ...prior?.tokens, ...usage.tokens }
          : hasTokenMeasurement
            ? undefined
            : prior?.tokens,
      tokensUnknown: hasTokenMeasurement ? usage.tokensUnknown : prior?.tokensUnknown,
    });
  }
}

function foldChildUsage(fold: DagUsageFold, record: ReadNodeRecordEvent): void {
  const { data, path } = record;
  if (data.child_usage !== undefined) {
    foldReportedChildUsage(fold, data.child_usage);
    for (const usage of data.child_usage) recordChildUsagePath(fold, usage.childRunId, path);
    return;
  }
  if (data.type !== 'workflow') return;
  const usage = readUsage(fold, path, record.rawUsage);
  if (
    (usage.costUsd ?? 0) === 0 &&
    !usage.tokensUnknown &&
    Object.values(usage.tokens ?? {}).every(
      value => value === undefined || value === 0 || (Array.isArray(value) && value.length === 0)
    )
  )
    return;
  const ids = new Set(
    data.fan_out_outcome?.slots.flatMap(slot => ('child_run_id' in slot ? [slot.child_run_id] : []))
  );
  if (data.child_run_id !== undefined) ids.add(data.child_run_id);
  // Historical fan-out increments cannot be allocated among children. Keep their
  // node-level spend readable without inventing cumulative child baselines.
  if (ids.size !== 1) {
    fold.unattributedChildUsagePaths.add(path);
    return;
  }
  // Legacy workflow rows report increments, unlike child_usage's cumulative baselines.
  for (const id of ids) {
    recordChildUsagePath(fold, id, path);
    const contributions = [fold.reportedChildUsage.get(id) ?? {}, usage];
    fold.reportedChildUsage.set(id, {
      costUsd: sumReportedCost(contributions),
      tokens: sumFanOutTokens(contributions),
      tokensUnknown: contributions.some(value => value.tokensUnknown),
    });
  }
}

export function countedUsage(
  fold: DagUsageFold
): Pick<DagResumeSnapshot, 'tokens' | 'tokensUnknown' | 'costUsd' | 'costPartial'> {
  const counted = fold.usageContributions;
  const tokensUnknown = counted.some(contribution => contribution.tokensUnknown);
  return {
    tokensUnknown,
    tokens: tokensUnknown
      ? undefined
      : mergeTokenUsage(
          counted.flatMap(contribution =>
            contribution.tokens === undefined ? [] : [contribution.tokens]
          )
        ),
    costUsd: sumReportedCost(counted),
    costPartial: counted.some(contribution => contribution.costPartial),
  };
}
