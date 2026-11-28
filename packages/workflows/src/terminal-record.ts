import { getRunArtifactsDirForRoot, resolveRunStorageRoot } from '@archon/paths/archon-paths';
import {
  type ArtifactManifest,
  RESULT_COMMIT_METADATA_KEY,
  resultCommitSchema,
  type ResultCommit,
  RUN_GRAPH_METADATA_KEY,
  runGraphSchema,
  terminalRecordSchema,
  terminalStatusSchema,
  type RunGraph,
  type RunNodeState,
  type TerminalRecord,
  WORKTREE_DISPOSITION_METADATA_KEY,
  worktreeDispositionSchema,
  type WorktreeDisposition,
} from './schemas/terminal-record';
import {
  nodeSkipReasonSchema,
  readOwnedWorktree,
  skipCauseSchema,
  type WorkflowRun,
} from './schemas/workflow-run';
import { observeArtifactManifest } from './terminal-artifact-manifest';
import {
  isExecNodeRecord,
  nodeInvocationKey,
  parseNodeInvocationKey,
  readNodeRecordData,
  readNodeRecordEvent,
  type ReadNodeRecordEvent,
} from './node-record-reader';
import {
  nodeOutcomesListingSchema,
  type NodeOutcome,
  type NodeOutcomesListing,
} from './schemas/node-outcomes';
import {
  nodeFailureKindSchema,
  type NodeDescriptor,
  type NodeExecutionMetadata,
  type NodeFailureKind,
  type NodeInvocation,
} from './schemas/node-execution';
import type { FanOutOutcome } from './schemas/fan-out-outcome';
import type { SerializedNodeData } from './node-record-serialization';
import type { LoopRound, LoopRoundNode } from './schemas/loop-rounds';
import type { RunProgress, RunStep } from './schemas/run-progress';

export interface TerminalRecordEvent {
  event_type: string;
  step_name?: string | null;
  data: unknown;
}
function withFanOutOutcome(
  state: RunNodeState,
  fanOutOutcome: FanOutOutcome | undefined
): RunNodeState {
  return fanOutOutcome === undefined ? state : { ...state, fan_out_outcome: fanOutOutcome };
}

interface NodeEventFold {
  graph: RunGraph | undefined;
  nodes: Map<string, RunNodeState>;
  outputs: Map<string, Record<string, unknown>>;
  /**
   * A failed exec node's recorded stdout, kept apart from `outputs`: the terminal return
   * and node outcomes read only a completed node's output, a loop round reads both.
   */
  failedOutputs: Map<string, Pick<SerializedNodeData, 'node_output' | 'node_output_truncated'>>;
  failureOrder: Map<string, number>;
  /** Each key's invocation timing, folded from its attempts; a cache record carries none. */
  timings: Map<string, InvocationTiming>;
  /** What each key's latest execution record says ran it. */
  executions: Map<string, { kind: NodeDescriptor['kind']; model?: string }>;
}

/**
 * The timing of a key's latest invocation across its attempts: when its first attempt
 * started, and each attempt's latest recorded duration by attempt id (undefined while
 * that attempt runs). An attempt's start and its end are two records of one attempt, so
 * keying by attempt id counts each attempt once. A node a resume runs again is a new
 * invocation, and is timed from its own start.
 */
interface InvocationTiming {
  invocationId: string;
  startedAt: string;
  attempts: Map<string, number | undefined>;
}

/**
 * Fold node-state events into one state per key. The terminal record keys by step path,
 * so a loop body node keeps only its latest iteration; the node-outcome observation keys
 * by invocation, so each iteration keeps its own entry. `node_id` is the step path either way.
 */
function foldNodeEvents(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  events: readonly TerminalRecordEvent[],
  keyOf: (path: string, loopPath: NodeInvocation['loopPath']) => string = path => path
): NodeEventFold {
  const parsed = runGraphSchema.safeParse(run.metadata?.[RUN_GRAPH_METADATA_KEY]);
  const graph = parsed.success ? parsed.data : undefined;
  const nodes = new Map<string, RunNodeState>();
  const outputs = new Map<string, Record<string, unknown>>();
  const failureOrder = new Map<string, number>();
  const failedOutputs: NodeEventFold['failedOutputs'] = new Map();
  const timings = new Map<string, InvocationTiming>();
  const executions: NodeEventFold['executions'] = new Map();
  const folded = { graph, nodes, outputs, failedOutputs, failureOrder, timings, executions };
  if (graph)
    for (const nodeId of graph.node_ids)
      nodes.set(keyOf(nodeId, []), { node_id: nodeId, state: 'pending' });
  for (const [index, event] of events.entries()) {
    const nodeId = event.step_name;
    if (!nodeId) continue;
    const record = readNodeRecordEvent({
      workflow_run_id: run.id,
      step_name: nodeId,
      event_type: event.event_type,
      data: event.data,
    });
    if (!record) continue;
    // A cache record carries no invocation, so it folds with no loop frames: a loop
    // body re-runs in full each iteration and never replays from the resume cache.
    foldNodeRecord(
      folded,
      record,
      keyOf(nodeId, record.metadata?.invocation.loopPath ?? []),
      index
    );
  }
  return folded;
}

function foldTiming(
  timings: Map<string, InvocationTiming>,
  key: string,
  { invocation, attempt, timing }: NodeExecutionMetadata
): void {
  const current = timings.get(key);
  const folded =
    current?.invocationId === invocation.id
      ? current
      : { invocationId: invocation.id, startedAt: invocation.startedAt, attempts: new Map() };
  folded.attempts.set(attempt.id, timing.durationMs);
  timings.set(key, folded);
}

/** Every attempt's duration, summed once all have ended: a running retry has none yet. */
function invocationDurationMs(timing: InvocationTiming | undefined): number | undefined {
  if (!timing || timing.attempts.size === 0) return undefined;
  let total = 0;
  for (const ms of timing.attempts.values()) {
    if (ms === undefined) return undefined;
    total += ms;
  }
  return total;
}

/** Exec writers record a failed command's stdout; only a loop round reads it. */
function keepFailedExecOutput(
  failedOutputs: NodeEventFold['failedOutputs'],
  key: string,
  record: ReadNodeRecordEvent
): void {
  const { node_output, node_output_truncated } = record.data;
  if (!isExecNodeRecord(record) || node_output === undefined) return;
  failedOutputs.set(key, {
    node_output,
    ...(node_output_truncated ? { node_output_truncated } : {}),
  });
}

function foldNodeRecord(
  {
    nodes,
    outputs,
    failedOutputs,
    failureOrder,
    timings,
    executions,
  }: Omit<NodeEventFold, 'graph'>,
  record: ReadNodeRecordEvent,
  key: string,
  index: number
): void {
  const nodeId = record.path;
  // Cache records (replay, reset, invalidation) carry no invocation or timing, and fold
  // under the top-level key, which no loop round reads.
  if (record.metadata) {
    foldTiming(timings, key, record.metadata);
    executions.set(key, {
      kind: record.metadata.node.kind,
      ...(record.data.model !== undefined ? { model: record.data.model } : {}),
    });
  }
  failedOutputs.delete(key);
  switch (record.eventType) {
    case 'node_started':
    case 'node_suspended':
    case 'node_always_run_reset':
    case 'node_prior_cache_invalidated':
      nodes.set(key, {
        node_id: nodeId,
        state:
          record.eventType === 'node_started' || record.eventType === 'node_suspended'
            ? 'running'
            : 'pending',
      });
      outputs.delete(key);
      failureOrder.delete(key);
      break;
    case 'node_completed':
      nodes.set(
        key,
        withFanOutOutcome({ node_id: nodeId, state: 'completed' }, record.data.fan_out_outcome)
      );
      outputs.set(key, record.data);
      failureOrder.delete(key);
      break;
    case 'node_skipped_prior_success':
      // A replayed node keeps the slot record its earlier completion wrote.
      nodes.set(
        key,
        withFanOutOutcome({ node_id: nodeId, state: 'completed' }, nodes.get(key)?.fan_out_outcome)
      );
      outputs.set(key, record.data);
      failureOrder.delete(key);
      break;
    case 'node_failed': {
      const data = record.data;
      nodes.set(
        key,
        withFanOutOutcome(
          {
            node_id: nodeId,
            state: 'failed',
            ...(typeof data.error === 'string' ? { error: data.error } : {}),
            ...(data.failure_kind !== undefined ? { failure_kind: data.failure_kind } : {}),
          },
          data.fan_out_outcome
        )
      );
      outputs.delete(key);
      keepFailedExecOutput(failedOutputs, key, record);
      failureOrder.set(key, index);
      break;
    }
    case 'node_skipped': {
      const data = record.data;
      const reason = nodeSkipReasonSchema.safeParse(data.reason);
      const cause = skipCauseSchema.safeParse(data.cause);
      nodes.set(key, {
        node_id: nodeId,
        state: 'skipped',
        ...(reason.success ? { reason: reason.data } : {}),
        ...(cause.success ? { cause: cause.data } : {}),
      });
      outputs.delete(key);
      failureOrder.delete(key);
      break;
    }
    default: {
      const exhaustiveCheck: never = record.eventType;
      throw new Error(`Unhandled NodeStateEventType: ${String(exhaustiveCheck)}`);
    }
  }
}

/** The engine's per-node state at any point in a run: the same fold the terminal record uses. */
export function buildRunNodeStates(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  events: readonly TerminalRecordEvent[]
): RunNodeState[] {
  return [...foldNodeEvents(run, events).nodes.values()];
}

/**
 * Whether a node of each kind records anything while it runs. An agent turn stores its
 * provider events and a heartbeat. A command, a wait on a child run, a gate, a timer and
 * a halt store nothing between their start and their end, and a container's nested nodes
 * record for themselves.
 */
const RECORDS_WHILE_RUNNING: Record<NodeDescriptor['kind'], boolean> = {
  agent: true,
  loop: true,
  exec: false,
  workflow: false,
  gate: false,
  wait: false,
  halt: false,
  loop_group: false,
  compose_fan_out: false,
  compose_fan_out_instance: false,
};

/**
 * A run's progress as a run list shows it. `steps` holds one step per node of the
 * recorded graph, in authored order, so a loop body or other nested path is not a step of
 * its own. A run recorded before the graph was lists every node its events name, in
 * first-appearance order. A pending node, whether not reached or reset for a re-run,
 * carries no timing: what an earlier invocation took is not this step's progress.
 *
 * `silent_by_design` reads every running node, nested ones included. A running node whose
 * record names no kind counts as one that records, so an old record never hides a stall.
 */
export function buildRunSteps(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  events: readonly TerminalRecordEvent[]
): Pick<RunProgress, 'steps' | 'silent_by_design'> {
  const { graph, nodes, timings, executions } = foldNodeEvents(run, events);
  const states = graph ? graph.node_ids.flatMap(id => nodes.get(id) ?? []) : [...nodes.values()];
  const steps = states.map(({ node_id, state }): RunStep => {
    if (state === 'pending') return { node_id, state };
    const timing = timings.get(node_id);
    const durationMs = state === 'running' ? undefined : invocationDurationMs(timing);
    const model = executions.get(node_id)?.model;
    return {
      node_id,
      state,
      ...(model !== undefined ? { model } : {}),
      ...(timing ? { started_at: timing.startedAt } : {}),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    };
  });
  const running = [...nodes].filter(([, node]) => node.state === 'running').map(([key]) => key);
  return {
    steps,
    silent_by_design:
      running.length > 0 &&
      running.every(key => {
        const kind = executions.get(key)?.kind;
        return kind !== undefined && !RECORDS_WHILE_RUNNING[kind];
      }),
  };
}

/**
 * What a running node observes as `$NODE_OUTCOMES_FILE`: every node invocation the run
 * has recorded, in the order each first appeared, with a completed node's structured
 * output. Graph nodes that have recorded nothing yet are `pending`.
 */
export function buildNodeOutcomes(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  events: readonly TerminalRecordEvent[]
): NodeOutcomesListing {
  const { nodes, outputs, failureOrder } = foldNodeEvents(run, events, nodeInvocationKey);
  const outcomes = [...nodes].map(([key, state]): NodeOutcome => {
    const { loopPath } = parseNodeInvocationKey(key);
    // The fold keeps output only for a completed entry and drops it on every later
    // state, so a failed, running or reset node never lists one.
    const data = outputs.get(key);
    return {
      ...state,
      ...(loopPath.length > 0 ? { loop_group_path: loopPath } : {}),
      ...(data && Object.hasOwn(data, 'structured_output')
        ? { output: data.structured_output }
        : {}),
    };
  });
  const firstFailed = [...failureOrder].sort((left, right) => left[1] - right[1])[0]?.[0];
  return nodeOutcomesListingSchema.parse({
    run_id: run.id,
    first_failed_node: firstFailed === undefined ? null : parseNodeInvocationKey(firstFailed).path,
    nodes: outcomes,
  });
}

/**
 * Each round of each `loop_group` the run has entered, in the order each round first
 * appeared, with the body node invocations it recorded. A running round lists the nodes
 * it has reached; one it has not reached yet is absent. Empty when the run ran no loop.
 */
export function buildLoopRounds(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  events: readonly TerminalRecordEvent[]
): LoopRound[] {
  const { nodes, outputs, failedOutputs, timings } = foldNodeEvents(run, events, nodeInvocationKey);
  const rounds = new Map<string, LoopRound>();
  for (const [key, state] of nodes) {
    const { loopPath } = parseNodeInvocationKey(key);
    if (loopPath.length === 0) continue;
    const roundKey = JSON.stringify(loopPath);
    let round = rounds.get(roundKey);
    if (!round) {
      round = { loop_group_path: loopPath, nodes: [] };
      rounds.set(roundKey, round);
    }
    round.nodes.push(
      loopRoundNode(state, timings.get(key), outputs.get(key) ?? failedOutputs.get(key))
    );
  }
  return [...rounds.values()];
}

function loopRoundNode(
  state: RunNodeState,
  timing: InvocationTiming | undefined,
  data: Record<string, unknown> | undefined
): LoopRoundNode {
  const entry: LoopRoundNode = { ...state };
  if (timing) entry.started_at = timing.startedAt;
  const durationMs = invocationDurationMs(timing);
  if (durationMs !== undefined) entry.duration_ms = durationMs;
  if (!data) return entry;
  if (typeof data.node_output === 'string') entry.output = data.node_output;
  if (data.node_output_truncated === true) entry.output_truncated = true;
  if (Object.hasOwn(data, 'structured_output')) entry.structured_output = data.structured_output;
  return entry;
}

/**
 * Failed and cancelled runs keep their worktree without inspecting it; only a completed
 * run's disposition needs git, so the executor assesses it and stores it in run metadata
 * before the terminal write.
 */
function readWorktreeDisposition(
  run: Pick<WorkflowRun, 'status' | 'metadata'>
): WorktreeDisposition | undefined {
  if (!readOwnedWorktree(run.metadata)) return undefined;
  switch (run.status) {
    case 'failed':
      return { disposition: 'retained', reason: 'resumable' };
    case 'cancelled':
      return { disposition: 'retained', reason: 'cancelled' };
    case 'completed': {
      const parsed = worktreeDispositionSchema.safeParse(
        run.metadata?.[WORKTREE_DISPOSITION_METADATA_KEY]
      );
      return parsed.success ? parsed.data : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * The executor samples a completed run's checkout and stores where its result holds in run
 * metadata before the terminal write. Only a completed run has a result. A malformed value
 * throws: it is engine-written, so it is damage, not "no commit".
 */
function readResultCommit(run: Pick<WorkflowRun, 'status' | 'metadata'>): ResultCommit | undefined {
  if (run.status !== 'completed') return undefined;
  const value = run.metadata?.[RESULT_COMMIT_METADATA_KEY];
  return value === undefined ? undefined : resultCommitSchema.parse(value);
}

function selectRecordedReturn(folded: NodeEventFold): TerminalRecord['returns'] {
  const selected = folded.graph?.returns;
  if (selected === undefined) {
    return {
      availability: 'unavailable',
      node_id: null,
      reason: folded.graph ? 'not_declared' : 'graph_unavailable',
    };
  }
  return returnOfNode(selected, folded);
}

/**
 * The run's returned value, as its terminal record and a run-ended or asks-settled binding
 * read it. `returnsNode` is the workflow's `returns:` node. Its node events decide it:
 *
 * - it did not complete: no value (`node_not_completed`);
 * - it carries structured output (`output_format`): that value, whatever its size, since
 *   structured output is persisted whole;
 * - its text fits the persisted output cap: the text, as a string, whether or not it is
 *   JSON. Typed data travels through `output_format`, never by sniffing text;
 * - its text passed the cap: no value, reported `truncated` with the spill path and the
 *   original size. The spill file is never read: it exists only on the host that ran
 *   the node, and the value must read the same everywhere.
 */
export function recordedReturn(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  events: readonly TerminalRecordEvent[],
  returnsNode: string
): TerminalRecord['returns'] {
  return returnOfNode(returnsNode, foldNodeEvents(run, events));
}

function returnOfNode(
  selected: string,
  { nodes, outputs }: NodeEventFold
): TerminalRecord['returns'] {
  const data = outputs.get(selected);
  if (nodes.get(selected)?.state !== 'completed') {
    return { availability: 'unavailable', node_id: selected, reason: 'node_not_completed' };
  }
  if (data && Object.hasOwn(data, 'structured_output')) {
    return { availability: 'available', node_id: selected, value: data.structured_output };
  }
  if (data?.node_output_truncated === true) {
    return {
      availability: 'truncated',
      node_id: selected,
      spill_path:
        typeof data.node_output_spill_path === 'string' ? data.node_output_spill_path : null,
      original_bytes:
        typeof data.node_output_original_bytes === 'number'
          ? data.node_output_original_bytes
          : null,
    };
  }
  if (typeof data?.node_output === 'string') {
    return { availability: 'available', node_id: selected, value: data.node_output };
  }
  return { availability: 'unavailable', node_id: selected, reason: 'output_not_persisted' };
}

function runArtifactsDir(run: Pick<WorkflowRun, 'id' | 'output_root'>): string | null {
  const root = resolveRunStorageRoot(run, null);
  return root === null ? null : getRunArtifactsDirForRoot(root, run.id);
}

/**
 * Walk the run's artifacts directory for its terminal record. This touches the
 * filesystem, so never await it while holding a database write transaction or the
 * file-store lock.
 */
export async function observeRunArtifacts(
  run: Pick<WorkflowRun, 'id' | 'output_root'>
): Promise<ArtifactManifest> {
  return observeArtifactManifest(
    runArtifactsDir(run),
    resolveRunStorageRoot(run, null) ?? undefined,
    run.id
  );
}

/** Artifact manifests walked before a terminal transaction, keyed by run id. */
export type TerminalArtifacts = ReadonlyMap<string, ArtifactManifest>;

export async function observeTerminalArtifacts(
  runs: readonly Pick<WorkflowRun, 'id' | 'output_root'>[]
): Promise<TerminalArtifacts> {
  return new Map(
    await Promise.all(runs.map(async run => [run.id, await observeRunArtifacts(run)] as const))
  );
}

/**
 * The manifest a terminal write records: `observed` when it was walked for the run's
 * current artifacts directory. A run can miss its walk between the caller's pre-read and
 * its transaction (a reset finds a run that became resumable, or a pending run gains its
 * `output_root`); it then records an empty manifest marked `not_observed`.
 */
export function terminalArtifactsFor(
  run: Pick<WorkflowRun, 'id' | 'output_root'>,
  observed: ArtifactManifest | undefined
): ArtifactManifest {
  const root = runArtifactsDir(run);
  if (observed !== undefined && observed.root === root) return observed;
  return {
    root,
    files: [],
    limitations: [{ path: '', kind: 'root_unavailable', code: 'not_observed' }],
  };
}

/** Fold ordered durable events; never reconstruct producer values from artifact contents. */
export function buildTerminalRecord(input: {
  run: Pick<WorkflowRun, 'id' | 'status' | 'outcome' | 'completed_outcome' | 'metadata'>;
  events: readonly TerminalRecordEvent[];
  artifacts: ArtifactManifest;
}): TerminalRecord {
  const { run, events, artifacts } = input;
  const folded = foldNodeEvents(run, events);
  const { nodes, failureOrder } = folded;
  const worktreeDisposition = readWorktreeDisposition(run);
  const resultCommit = readResultCommit(run);
  return terminalRecordSchema.parse({
    run_id: run.id,
    status: terminalStatusSchema.parse(run.status),
    outcome: run.outcome,
    completed_outcome: run.completed_outcome,
    error: typeof run.metadata?.error === 'string' ? run.metadata.error : null,
    first_failed_node: [...failureOrder].sort((left, right) => left[1] - right[1])[0]?.[0] ?? null,
    nodes: [...nodes.values()],
    returns: selectRecordedReturn(folded),
    artifacts,
    ...(worktreeDisposition ? { worktree_disposition: worktreeDisposition } : {}),
    ...(resultCommit ? { result_commit: resultCommit } : {}),
  });
}

/** Historical terminal events have no record. Active resumed runs expose none. */
export function getTerminalRecord(
  runStatus: WorkflowRun['status'],
  events: readonly TerminalRecordEvent[]
): TerminalRecord | null {
  if (!terminalStatusSchema.safeParse(runStatus).success) return null;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.event_type !== `workflow_${runStatus}`) continue;
    const data = readNodeRecordData(event.data);
    if (data.terminal_record === undefined) return null;
    const record = terminalRecordSchema.parse(data.terminal_record);
    if (record.status !== runStatus)
      throw new Error('Terminal record status differs from its terminal event');
    return record;
  }
  return null;
}

/**
 * The `node_failed` event behind a record's `first_failed_node`: the last one for that
 * node in `events`. Terminal telemetry and the attention stream both read the failure
 * cause through this, so they agree on which event is the failure.
 */
export function firstFailedNodeEvent<E extends TerminalRecordEvent>(
  record: Pick<TerminalRecord, 'first_failed_node'> | null,
  events: readonly E[]
): E | undefined {
  const node = record?.first_failed_node;
  if (node == null) return undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.event_type === 'node_failed' && event.step_name === node) return event;
  }
  return undefined;
}

/** The per-node state of a record's `first_failed_node`, when it has one. */
export function firstFailedNodeState(
  record: Pick<TerminalRecord, 'first_failed_node' | 'nodes'>
): TerminalRecord['nodes'][number] | undefined {
  return record.nodes.find(node => node.node_id === record.first_failed_node);
}

/** The failure kind a `node_failed` event recorded; undefined when it recorded none. */
export function recordedFailureKind(event: TerminalRecordEvent): NodeFailureKind | undefined {
  const kind = nodeFailureKindSchema.safeParse(readNodeRecordData(event.data).failure_kind);
  return kind.success ? kind.data : undefined;
}

const REASON_LINES = 2;
const REASON_LINE_LENGTH = 200;

/** The first line of `text` that says anything. */
function firstLine(text: string): string | undefined {
  return text
    .split('\n')
    .map(candidate => candidate.trim())
    .find(candidate => candidate !== '');
}

/** What a returned value says in text: its lines, or each text field of an object as `key: text`. */
function returnedText(value: unknown): string[] {
  if (typeof value === 'string') return value.split('\n').map(line => line.trim());
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, field]) => {
    const line = typeof field === 'string' ? firstLine(field) : undefined;
    // A key is authored text too: one with a line break must not make the entry span lines.
    // Only the breaks are replaced, so any other key is written as authored.
    return line === undefined ? [] : [`${key.replace(/\s*[\r\n]+\s*/g, ' ')}: ${line}`];
  });
}

const boundedReason = (lines: readonly string[]): string[] =>
  lines
    .filter(line => line !== '')
    .slice(0, REASON_LINES)
    .map(line =>
      line.length > REASON_LINE_LENGTH ? `${line.slice(0, REASON_LINE_LENGTH - 1)}…` : line
    );

/**
 * Why a run completed with a failed outcome, in at most two short lines: what its
 * `returns:` node said, since that node authored the verdict. Empty for any other run and
 * when the record holds no returned text. The attention stream carries this, because the
 * workflow wrote it to be read as the run's result.
 */
export function failedOutcomeReason(record: TerminalRecord | null): string[] {
  if (record?.status !== 'completed' || record.outcome !== 'failed') return [];
  if (record.returns.availability !== 'available') return [];
  return boundedReason(returnedText(record.returns.value));
}

/**
 * Why a run that ended needs a look, for a reader of that one run: the failed-outcome
 * reason, or for a failed run the first line of its first failed node's error, or else of
 * the run's own, led by that node's recorded failure kind. Error text is whatever a
 * command or provider printed, so it stays out of the attention stream, which uses
 * structured failure facts instead.
 */
export function terminalReason(record: TerminalRecord | null): string[] {
  if (record?.status !== 'failed') return failedOutcomeReason(record);
  const failed = firstFailedNodeState(record);
  const reason = boundedReason([firstLine(failed?.error ?? record.error ?? '') ?? '']);
  const kind = failed?.failure_kind;
  return kind === undefined
    ? reason
    : reason.map((line, i) => (i === 0 ? `(${kind}) ${line}` : line));
}
