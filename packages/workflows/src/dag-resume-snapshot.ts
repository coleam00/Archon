import { readFile } from 'node:fs/promises';
import { createLogger } from '@archon/paths';
import { mergeTokenUsage, type TokenUsage } from '@archon/provider-contract';
import type { FanOutInstanceSnapshot } from './fan-out-identity';
import { nodeInvocationKey, readNodeRecordEvent } from './node-record-reader';
import { nodeCostScope } from './node-record-serialization';
import type { NodeExecutionMetadata } from './schemas/node-execution';
import { NODE_STATE_EVENT_TYPES, type DagResumeSnapshot, type PersistedNodeOutput } from './store';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  return (cachedLog ??= createLogger('workflow.dag-resume-snapshot'));
}

export interface DagResumeEvent {
  step_name?: string | null;
  event_type: string;
  data?: string | Record<string, unknown>;
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

/**
 * Return completed node outputs and cumulative usage (tokens AND cost) for a workflow
 * run. Used by the DAG executor to restore state when resuming a failed run.
 * Throws on invalid execution records — caller owns the degradation policy.
 *
 * Both usage axes are summed from `node_completed` and `node_failed` rows, and only
 * from rows whose `nodeCostScope` is their own spend. Failed rows contribute spend but
 * never completed outputs, so their nodes remain eligible for resume.
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
 */
export async function foldDagResumeSnapshot(
  rows: readonly DagResumeEvent[],
  workflowRunId: string
): Promise<DagResumeSnapshot> {
  const completedNodeOutputs = new Map<string, PersistedNodeOutput>();
  const fanOutSnapshots = new Map<string, readonly FanOutInstanceSnapshot[]>();
  const unresolvedNodeStarts = new Set<string>();
  const unfinishedInvocations = new Map<string, NodeExecutionMetadata>();
  // The completion a reusable output belongs to. A prior-success replay row carries no
  // execution facts of its own, so it inherits the completion it replays.
  const completedExecutions = new Map<string, NodeExecutionMetadata>();
  // Collected and merged once at the end rather than folded pairwise: a pairwise fold
  // cannot tell "one of five contributions reported" from "one of two" (#2662).
  const usageContributions: { stepName: string; tokens?: TokenUsage; costUsd?: number }[] = [];
  const authoritativeInstanceScopes = new Set<string>();
  for (const row of rows) {
    if (
      !row.step_name ||
      (!NODE_STATE_EVENT_TYPES.some(type => type === row.event_type) &&
        row.event_type !== 'fan_out_instances')
    )
      continue;
    if (row.event_type !== 'fan_out_instances') {
      if (row.event_type === 'node_started' || row.event_type === 'node_suspended')
        unresolvedNodeStarts.add(row.step_name);
      else unresolvedNodeStarts.delete(row.step_name);
      // Every later node state supersedes reusable success, even when that row
      // carries no output (or its data cannot be recovered). Only success restores it.
      completedNodeOutputs.delete(row.step_name);
    }
    let rawData: Record<string, unknown>;
    let record: ReturnType<typeof readNodeRecordEvent>;
    try {
      rawData = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data ?? {});
    } catch (parseErr) {
      getLog().warn(
        { err: parseErr as Error, runId: workflowRunId, stepName: row.step_name },
        'db.workflow_dag_node_output_parse_failed'
      );
      continue;
    }
    if (row.event_type === 'fan_out_instances') {
      if (!fanOutSnapshots.has(row.step_name)) {
        const snapshots = parseFanOutSnapshots(rawData.instances);
        if (snapshots !== undefined) fanOutSnapshots.set(row.step_name, snapshots);
      }
      continue;
    }
    try {
      record = readNodeRecordEvent({
        workflow_run_id: workflowRunId,
        step_name: row.step_name,
        event_type: row.event_type,
        data: rawData,
      });
    } catch (parseErr) {
      throw new Error(
        `Invalid node execution record for '${row.step_name}' in run ${workflowRunId}`,
        { cause: parseErr }
      );
    }
    if (!record) continue;
    const data = record.data;
    if (record.metadata) {
      const key = nodeInvocationKey(record.path, record.metadata.invocation.loopPath);
      if (
        record.eventType === 'node_started' ||
        record.eventType === 'node_suspended' ||
        record.eventType === 'node_failed'
      ) {
        unfinishedInvocations.set(key, record.metadata);
      } else if (record.eventType === 'node_completed' || record.eventType === 'node_skipped') {
        unfinishedInvocations.delete(key);
      }
      if (record.eventType === 'node_completed')
        completedExecutions.set(record.path, record.metadata);
      else completedExecutions.delete(record.path);
    } else if (
      record.eventType === 'node_skipped_prior_success' ||
      record.eventType === 'node_always_run_reset' ||
      record.eventType === 'node_prior_cache_invalidated'
    ) {
      for (const [key, metadata] of unfinishedInvocations)
        if (metadata.path === record.path) unfinishedInvocations.delete(key);
    }
    if (
      row.event_type !== 'node_completed' &&
      row.event_type !== 'node_skipped_prior_success' &&
      row.event_type !== 'node_failed'
    )
      continue;
    if (row.event_type !== 'node_failed' && typeof data.node_output === 'string') {
      // A bash/script node's persisted text is a bounded preview once it exceeded the
      // truncation cap; the full bytes were spilled to `node_output_spill_path` at write
      // time (#2726). Prefer the spill so a resumed run's `$node.output`/`.field` sees
      // exactly what a fresh run's in-process consumer would have. A missing/unreadable
      // spill retains the preview and its incompleteness rather than failing resume.
      // Prior-success replay must preserve that provenance for later terminal records.
      //
      // The spill file is addressed by a stable, node-scoped filename that a later
      // execution of the SAME node overwrites in place (by design — see
      // `formatPersistedNodeOutput`'s doc comment). The spill precedes its awaited
      // lifecycle insert, so a process crash between the file overwrite and that insert
      // can still leave an older, durable row pointing at
      // a NEWER execution's content. Guard against that by validating the file's actual
      // byte length against this row's own recorded `node_output_original_bytes` before
      // trusting it — a mismatch means the file no longer describes this row, so fall
      // back to the bounded preview exactly like a missing spill would.
      let output = data.node_output;
      let outputTruncation: PersistedNodeOutput['outputTruncation'] =
        data.node_output_truncated === true || typeof data.node_output_spill_path === 'string'
          ? {
              originalBytes:
                typeof data.node_output_original_bytes === 'number'
                  ? data.node_output_original_bytes
                  : null,
              spillPath:
                typeof data.node_output_spill_path === 'string'
                  ? data.node_output_spill_path
                  : null,
            }
          : undefined;
      if (typeof data.node_output_spill_path === 'string') {
        try {
          const spilled = await readFile(data.node_output_spill_path, 'utf8');
          const spilledBytes = Buffer.byteLength(spilled, 'utf8');
          if (
            typeof data.node_output_original_bytes === 'number' &&
            spilledBytes !== data.node_output_original_bytes
          ) {
            getLog().warn(
              {
                runId: workflowRunId,
                stepName: row.step_name,
                spillPath: data.node_output_spill_path,
                expectedBytes: data.node_output_original_bytes,
                actualBytes: spilledBytes,
              },
              'db.workflow_dag_node_output_spill_stale'
            );
          } else {
            output = spilled;
            outputTruncation = undefined;
          }
        } catch (spillErr) {
          getLog().warn(
            {
              err: spillErr as Error,
              runId: workflowRunId,
              stepName: row.step_name,
              spillPath: data.node_output_spill_path,
            },
            'db.workflow_dag_node_output_spill_read_failed'
          );
        }
      }
      completedNodeOutputs.set(row.step_name, {
        output,
        ...(outputTruncation !== undefined ? { outputTruncation } : {}),
        // The node's logical value (#2637), persisted beside its text by the emit
        // sites (and copied forward by node_skipped_prior_success re-emits). Absent
        // on pre-#2637 rows — the executor then falls back to text re-parsing.
        ...(data.structured_output !== undefined
          ? { structuredOutput: data.structured_output }
          : {}),
        // The persisted contract owns authorization on resume, especially for a child
        // result whose schema is not available in the parent's definition. The reader
        // already turned a legacy `declared_fields` row into depth-1 paths.
        ...(data.declared_output_paths !== undefined
          ? { declaredOutputPaths: data.declared_output_paths }
          : {}),
        ...(completedExecutions.has(row.step_name)
          ? { execution: completedExecutions.get(row.step_name) }
          : {}),
      });
    }
    // Composed-instance terminals are the durable accounting source for their whole
    // scope. Their inner rows are observability writes and may be missing after a crash.
    const isAuthoritativeInstanceUsage =
      data.type === 'compose_fan_out_instance' &&
      (row.event_type === 'node_completed' || row.event_type === 'node_failed');
    if (isAuthoritativeInstanceUsage) authoritativeInstanceScopes.add(row.step_name);
    // Other aggregate rows merely restate usage already carried by their leaves.
    if (nodeCostScope(data) === 'total' && !isAuthoritativeInstanceUsage) continue;
    const contribution: { stepName: string; tokens?: TokenUsage; costUsd?: number } = {
      stepName: row.step_name,
    };
    if (row.event_type !== 'node_skipped_prior_success' && record.rawUsage.tokens !== undefined) {
      const eventTokens = record.rawUsage.tokens;
      if (
        typeof eventTokens === 'object' &&
        eventTokens !== null &&
        'input' in eventTokens &&
        'output' in eventTokens &&
        typeof eventTokens.input === 'number' &&
        typeof eventTokens.output === 'number' &&
        Number.isFinite(eventTokens.input) &&
        Number.isFinite(eventTokens.output)
      ) {
        const normalized: TokenUsage = {
          input: eventTokens.input,
          output: eventTokens.output,
        };
        const optionalTokens = eventTokens as Record<string, unknown>;
        for (const axis of ['cacheRead', 'cacheWrite'] as const) {
          const value = optionalTokens[axis];
          if (value === undefined) continue;
          if (typeof value === 'number' && Number.isFinite(value)) {
            normalized[axis] = value;
          } else {
            getLog().warn(
              { runId: workflowRunId, stepName: row.step_name, axis, value },
              'db.workflow_dag_node_optional_tokens_invalid_ignored'
            );
          }
        }
        // A node whose own usage was already a floor (a loop total, an OpenCode
        // multi-agent node) keeps the resumed run a floor. Anything other than `true`
        // is ignored without a warn: unlike the numeric axes it carries no total.
        if (optionalTokens.cachePartial === true) {
          normalized.cachePartial = true;
        }
        contribution.tokens = normalized;
      } else {
        getLog().warn(
          { runId: workflowRunId, stepName: row.step_name, tokens: eventTokens },
          'db.workflow_dag_node_tokens_invalid_ignored'
        );
      }
    }
    if (row.event_type !== 'node_skipped_prior_success' && record.rawUsage.costUsd !== undefined) {
      const eventCost = record.rawUsage.costUsd;
      // Same guard shape as tokens: a non-finite value from a provider must not
      // silently poison the total (NaN > 0 is false, which would drop the run's
      // cost from the persisted metadata with no trace).
      if (typeof eventCost === 'number' && Number.isFinite(eventCost)) {
        contribution.costUsd = eventCost;
      } else {
        getLog().warn(
          { runId: workflowRunId, stepName: row.step_name, costUsd: eventCost },
          'db.workflow_dag_node_cost_invalid_ignored'
        );
      }
    }
    if (contribution.tokens !== undefined || contribution.costUsd !== undefined) {
      usageContributions.push(contribution);
    }
  }
  const authoritativeInstancePrefixes = [...authoritativeInstanceScopes].map(scope => `${scope}__`);
  const countedUsage = usageContributions.filter(
    contribution =>
      !authoritativeInstancePrefixes.some(prefix => contribution.stepName.startsWith(prefix))
  );
  return {
    unfinishedInvocations,
    completedNodeOutputs,
    fanOutSnapshots,
    unresolvedNodeStarts,
    tokens: mergeTokenUsage(
      countedUsage.flatMap(contribution =>
        contribution.tokens === undefined ? [] : [contribution.tokens]
      )
    ),
    costUsd: countedUsage.reduce((total, contribution) => total + (contribution.costUsd ?? 0), 0),
  };
}
