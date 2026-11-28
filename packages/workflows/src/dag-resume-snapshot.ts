import { readFile } from 'node:fs/promises';
import { createLogger } from '@archon/paths';
import {
  countedUsage,
  foldDagUsageRecord,
  foldDeferredUsage,
  newDagUsageFold,
  type DagUsageFold,
} from './dag-usage-fold';
import type { FanOutInstanceSnapshot } from './fan-out-identity';
import { nodeInvocationKey, readNodeRecordEvent } from './node-record-reader';
import {
  DEFERRED_NODE_USAGE_EVENT_TYPE,
  type SerializedNodeData,
} from './node-record-serialization';
import { nodeFailureKindSchema, type NodeExecutionMetadata } from './schemas/node-execution';
import {
  RUN_BUDGET_WORK_UNIT_EVENT_TYPE,
  addAttemptSpend,
  emptyRunBudgetUsage,
  type RunBudgetUsage,
} from './run-budget';
import {
  DURABLE_WORKFLOW_EVENT_TYPES,
  NODE_STATE_EVENT_TYPES,
  foldActiveNodeIds,
  type DagResumeSnapshot,
  type PersistedNodeOutput,
  type PriorFailedNode,
} from './store';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  return (cachedLog ??= createLogger('workflow.dag-resume-snapshot'));
}

export interface DagResumeEvent {
  step_name?: string | null;
  event_type: string;
  data?: string | Record<string, unknown>;
}

/**
 * Keep the failure a `node_failed` row records, as a later pass replays it. Every other
 * node state row already cleared the entry, so a node that ran again is not kept.
 */
function recordPriorFailure(
  failedNodes: Map<string, PriorFailedNode>,
  eventType: string,
  stepName: string,
  data: Record<string, unknown>
): void {
  if (eventType !== 'node_failed') return;
  const kind = nodeFailureKindSchema.safeParse(data.failure_kind);
  failedNodes.set(stepName, {
    error: typeof data.error === 'string' ? data.error : 'the node failed in an earlier pass',
    ...(kind.success ? { failureKind: kind.data } : {}),
  });
}

function isFanOutItem(value: unknown): value is FanOutInstanceSnapshot['item'] {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isFanOutItem);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isFanOutItem);
}

function isFanOutInputs(value: unknown): value is Record<string, FanOutInstanceSnapshot['item']> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isFanOutItem)
  );
}

function parseFanOutSnapshots(value: unknown): FanOutInstanceSnapshot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const identities = new Set<string>();
  const snapshots: FanOutInstanceSnapshot[] = [];
  for (const [index, entry] of value.entries()) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('ordinal' in entry) ||
      !('identity' in entry) ||
      !('item' in entry) ||
      !('inputs' in entry) ||
      entry.ordinal !== index ||
      typeof entry.identity !== 'string' ||
      entry.identity.length === 0 ||
      identities.has(entry.identity) ||
      !isFanOutItem(entry.item) ||
      !isFanOutInputs(entry.inputs)
    ) {
      return undefined;
    }
    identities.add(entry.identity);
    snapshots.push({
      ordinal: index,
      identity: entry.identity,
      item: entry.item,
      inputs: entry.inputs,
    });
  }
  return snapshots;
}

/** What one fold accumulates across a run's rows. */
interface ResumeFold extends DagUsageFold {
  readonly completedNodeOutputs: Map<string, PersistedNodeOutput>;
  readonly failedNodes: Map<string, PriorFailedNode>;
  readonly fanOutSnapshots: Map<string, readonly FanOutInstanceSnapshot[]>;
  readonly unresolvedNodeStarts: Set<string>;
  readonly unfinishedInvocations: Map<string, NodeExecutionMetadata>;
  /** The completion a reusable output belongs to. A prior-success replay row carries no
   * execution facts of its own, so it inherits the completion it replays. */
  readonly completedExecutions: Map<string, NodeExecutionMetadata>;
  readonly budget: RunBudgetUsage;
  /** Started `agent` attempts with no terminal row yet: attempt id → path. */
  readonly openAgentAttempts: Map<string, string>;
  /** An attempt can carry a second terminal row (the dispatch catch re-finishes its start
   * record after an engine-side throw); the live ledger charged only the first. */
  readonly settledAgentAttempts: Set<string>;
}

type FoldedRow = DagResumeEvent & { step_name: string };
type NodeRecord = NonNullable<ReturnType<typeof readNodeRecordEvent>>;

function isFoldedRow(row: DagResumeEvent): row is FoldedRow {
  return (
    Boolean(row.step_name) &&
    (DURABLE_WORKFLOW_EVENT_TYPES.some(type => type === row.event_type) ||
      row.event_type === 'fan_out_instances')
  );
}

/** The row's data, or undefined after a warn when its JSON cannot be parsed. */
function parseRowData(fold: ResumeFold, row: FoldedRow): Record<string, unknown> | undefined {
  try {
    return typeof row.data === 'string' ? JSON.parse(row.data) : (row.data ?? {});
  } catch (parseErr) {
    getLog().warn(
      { err: parseErr as Error, runId: fold.runId, stepName: row.step_name },
      'db.workflow_dag_node_output_parse_failed'
    );
    return undefined;
  }
}

function foldFanOutInstances(fold: ResumeFold, row: FoldedRow): void {
  const rawData = parseRowData(fold, row);
  if (rawData === undefined || fold.fanOutSnapshots.has(row.step_name)) return;
  const snapshots = parseFanOutSnapshots(rawData.instances);
  if (snapshots !== undefined) fold.fanOutSnapshots.set(row.step_name, snapshots);
}

function readRecord(
  fold: ResumeFold,
  row: FoldedRow,
  rawData: Record<string, unknown>
): NodeRecord | undefined {
  try {
    return readNodeRecordEvent({
      workflow_run_id: fold.runId,
      step_name: row.step_name,
      event_type: row.event_type,
      data: rawData,
    });
  } catch (parseErr) {
    throw new Error(`Invalid node execution record for '${row.step_name}' in run ${fold.runId}`, {
      cause: parseErr,
    });
  }
}

function foldAgentAttempt(fold: ResumeFold, record: NodeRecord): void {
  const metadata = record.metadata;
  if (metadata?.node.kind !== 'agent' || metadata.accounting !== 'node') return;
  const attemptId = metadata.attempt.id;
  if (record.eventType === 'node_started') {
    fold.openAgentAttempts.set(attemptId, record.path);
    return;
  }
  if (record.eventType !== 'node_completed' && record.eventType !== 'node_failed') return;
  fold.openAgentAttempts.delete(attemptId);
  if (fold.settledAgentAttempts.has(attemptId)) return;
  fold.settledAgentAttempts.add(attemptId);
  addAttemptSpend(fold.budget, record.path, metadata);
}

function foldInvocation(fold: ResumeFold, record: NodeRecord): void {
  if (record.metadata) foldExecutedInvocation(fold, record, record.metadata);
  else forgetReplayedInvocations(fold, record);
}

function foldExecutedInvocation(
  fold: ResumeFold,
  record: NodeRecord,
  metadata: NodeExecutionMetadata
): void {
  const key = nodeInvocationKey(record.path, metadata.invocation.loopPath);
  if (
    record.eventType === 'node_started' ||
    record.eventType === 'node_suspended' ||
    record.eventType === 'node_failed'
  ) {
    fold.unfinishedInvocations.set(key, metadata);
  } else if (record.eventType === 'node_completed' || record.eventType === 'node_skipped') {
    fold.unfinishedInvocations.delete(key);
  }
  if (record.eventType === 'node_completed') fold.completedExecutions.set(record.path, metadata);
  else fold.completedExecutions.delete(record.path);
}

function forgetReplayedInvocations(fold: ResumeFold, record: NodeRecord): void {
  if (
    record.eventType !== 'node_skipped_prior_success' &&
    record.eventType !== 'node_always_run_reset' &&
    record.eventType !== 'node_prior_cache_invalidated'
  )
    return;
  for (const [key, unfinished] of fold.unfinishedInvocations)
    if (unfinished.path === record.path) fold.unfinishedInvocations.delete(key);
}

/**
 * A bash/script node's persisted text is a bounded preview once it exceeded the
 * truncation cap; the full bytes were spilled to `node_output_spill_path` at write
 * time (#2726). Prefer the spill so a resumed run's `$node.output`/`.field` sees
 * exactly what a fresh run's in-process consumer would have. A missing/unreadable
 * spill retains the preview and its incompleteness rather than failing resume.
 * Prior-success replay must preserve that provenance for later terminal records.
 *
 * New spills use a unique path per write. Historical events can still point at a
 * reused node-scoped path; the byte-length check detects mismatched lengths but
 * cannot identify an equal-length replacement of those historical spills.
 */
async function readSpilledOutput(
  runId: string,
  stepName: string,
  spillPath: string,
  expectedBytes: number | undefined
): Promise<string | undefined> {
  try {
    const spilled = await readFile(spillPath, 'utf8');
    const spilledBytes = Buffer.byteLength(spilled, 'utf8');
    if (expectedBytes === undefined || spilledBytes === expectedBytes) return spilled;
    getLog().warn(
      { runId, stepName, spillPath, expectedBytes, actualBytes: spilledBytes },
      'db.workflow_dag_node_output_spill_stale'
    );
  } catch (spillErr) {
    getLog().warn(
      { err: spillErr as Error, runId, stepName, spillPath },
      'db.workflow_dag_node_output_spill_read_failed'
    );
  }
  return undefined;
}

async function readNodeOutputText(
  runId: string,
  stepName: string,
  data: SerializedNodeData,
  preview: string
): Promise<Pick<PersistedNodeOutput, 'output' | 'outputTruncation'>> {
  const spillPath = data.node_output_spill_path;
  if (spillPath !== undefined) {
    const spilled = await readSpilledOutput(
      runId,
      stepName,
      spillPath,
      data.node_output_original_bytes
    );
    if (spilled !== undefined) return { output: spilled };
  } else if (data.node_output_truncated !== true) {
    return { output: preview };
  }
  return {
    output: preview,
    outputTruncation: {
      originalBytes: data.node_output_original_bytes ?? null,
      spillPath: spillPath ?? null,
    },
  };
}

async function readCompletedOutput(
  fold: ResumeFold,
  stepName: string,
  data: SerializedNodeData,
  preview: string
): Promise<PersistedNodeOutput> {
  const { output, outputTruncation } = await readNodeOutputText(
    fold.runId,
    stepName,
    data,
    preview
  );
  const execution = fold.completedExecutions.get(stepName);
  return {
    output,
    ...(outputTruncation !== undefined ? { outputTruncation } : {}),
    // The node's logical value (#2637), persisted beside its text by the emit
    // sites (and copied forward by node_skipped_prior_success re-emits). Absent
    // on pre-#2637 rows — the executor then falls back to text re-parsing.
    ...(data.structured_output !== undefined ? { structuredOutput: data.structured_output } : {}),
    // The persisted contract owns authorization on resume, especially for a child
    // result whose schema is not available in the parent's definition. The reader
    // already turned a legacy `declared_fields` row into depth-1 paths.
    ...(data.declared_output_paths !== undefined
      ? { declaredOutputPaths: data.declared_output_paths }
      : {}),
    ...(execution !== undefined ? { execution } : {}),
  };
}

async function foldNodeRow(fold: ResumeFold, row: FoldedRow): Promise<void> {
  const nodeStateType = NODE_STATE_EVENT_TYPES.find(type => type === row.event_type);
  if (nodeStateType) foldActiveNodeIds(fold.unresolvedNodeStarts, row.step_name, nodeStateType);
  // Every later node state supersedes reusable success, even when that row
  // carries no output (or its data cannot be recovered). Only success restores it.
  fold.completedNodeOutputs.delete(row.step_name);
  fold.failedNodes.delete(row.step_name);
  const rawData = parseRowData(fold, row);
  if (rawData === undefined) return;
  const record = readRecord(fold, row, rawData);
  if (!record) return;
  foldAgentAttempt(fold, record);
  foldInvocation(fold, record);
  const data = record.data;
  recordPriorFailure(fold.failedNodes, row.event_type, row.step_name, data);
  foldDagUsageRecord(fold, row, record);
  if (
    row.event_type !== 'node_completed' &&
    row.event_type !== 'node_skipped_prior_success' &&
    row.event_type !== 'node_failed'
  )
    return;
  if (row.event_type !== 'node_failed' && typeof data.node_output === 'string') {
    fold.completedNodeOutputs.set(
      row.step_name,
      await readCompletedOutput(fold, row.step_name, data, data.node_output)
    );
  }
}

async function foldRow(fold: ResumeFold, row: FoldedRow): Promise<void> {
  switch (row.event_type) {
    case RUN_BUDGET_WORK_UNIT_EVENT_TYPE:
      fold.budget.workUnits++;
      return;
    case DEFERRED_NODE_USAGE_EVENT_TYPE:
      foldDeferredUsage(fold, row);
      return;
    case 'fan_out_instances':
      foldFanOutInstances(fold, row);
      return;
    default:
      await foldNodeRow(fold, row);
  }
}

/**
 * Return completed node outputs and cumulative usage (tokens AND cost) for a workflow
 * run. Used by the DAG executor to restore state when resuming a failed run.
 * Throws on invalid execution records — caller owns the degradation policy.
 *
 * Both usage axes are summed from `node_completed`, `node_failed` and `node_deferred_usage`
 * rows, and only from rows whose `nodeCostScope` is their own spend. Failed rows contribute
 * spend but never completed outputs, so their nodes remain eligible for resume. A
 * deferred-usage row is accounting only: it never changes lifecycle state or output.
 *
 * This makes a run's total MONEY BURNED, not the cost of the surviving path — the
 * figure an operator watching a budget wants, and a deliberate change from what the
 * number meant before failed rows were summed (#2654). Three consequences follow, all
 * intended:
 *
 * - The same node's first and second attempt both count. A node that failed at $0.02
 *   and succeeded at $0.03 on resume contributes $0.05, because both rows are real
 *   spend.
 * - `retry:` counts every attempt, for the same reason — `runNodeRetryLoop` writes one
 *   event per attempt.
 * - An `always_run` node re-executes on every resume pass and its spend accrues each
 *   time.
 *
 * A resumed run's total therefore exceeds what the surviving path cost, and grows with
 * each resume. That is the point; it is not double counting, which is what the two
 * exclusions below prevent.
 *
 * Cache axes sum over the rows that reported them and carry `cachePartial` when any row
 * did not, so a pre-#2654 row narrows the cache total instead of erasing it. Two
 * distinct duplication hazards:
 *
 * - `node_skipped_prior_success` rows replay a node an earlier pass already counted, so
 *   counting them would multiply that node's usage by the number of resume passes.
 * - `total`-scope rows are derived from other rows already in this log — a
 *   `loop_group`'s roll-up restates the `cost_usd` its own `<groupId>.<nodeId>` body rows
 *   carry, so summing both counts that group twice (#2469).
 *
 * Rows written before the `aggregate` marker existed carry no flag, so a run that
 * completed a loop_group under an older build and is resumed under this one can still
 * double-count its cost. Bounded and self-clearing: only cost is affected (the roll-up
 * never carried `tokens`), and only until those runs reach a terminal state.
 *
 * The run budget (`budget`) is folded separately and fails closed: it counts one
 * work unit per `run_budget_work_unit` row and charges each own-scope `agent` attempt
 * through `addAttemptSpend`, so an attempt whose cost is unreported, partial or
 * invalid, or one that started and never reached a terminal row, marks spend
 * unavailable instead of adding nothing as the telemetry total does.
 */
export async function foldDagResumeSnapshot(
  rows: readonly DagResumeEvent[],
  workflowRunId: string
): Promise<DagResumeSnapshot> {
  const fold: ResumeFold = {
    ...newDagUsageFold(workflowRunId),
    completedNodeOutputs: new Map(),
    failedNodes: new Map(),
    fanOutSnapshots: new Map(),
    unresolvedNodeStarts: new Set(),
    unfinishedInvocations: new Map(),
    completedExecutions: new Map(),
    budget: emptyRunBudgetUsage(),
    openAgentAttempts: new Map(),
    settledAgentAttempts: new Set(),
  };
  for (const row of rows) {
    if (isFoldedRow(row)) await foldRow(fold, row);
  }
  for (const path of fold.openAgentAttempts.values()) {
    fold.budget.costUnavailable ??= { path, reason: 'interrupted' };
  }
  return {
    reportedChildUsage: fold.reportedChildUsage,
    unattributedChildUsagePaths: fold.unattributedChildUsagePaths,
    unfinishedInvocations: fold.unfinishedInvocations,
    loopUsageBaselines: new Map(
      fold.usageContributions.flatMap(({ loopBaseline }) =>
        loopBaseline === undefined
          ? []
          : [[loopBaseline.invocation.id, loopBaseline.spend] as const]
      )
    ),
    completedNodeOutputs: fold.completedNodeOutputs,
    failedNodes: fold.failedNodes,
    fanOutSnapshots: fold.fanOutSnapshots,
    unresolvedNodeStarts: fold.unresolvedNodeStarts,
    ...countedUsage(fold),
    budget: fold.budget,
  };
}
