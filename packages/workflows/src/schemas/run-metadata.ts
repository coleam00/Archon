/**
 * Keys the engine writes into a run row's untyped `metadata` JSONB, each with the typed
 * reader that is the only way to read it back.
 */
import { isAbsolute } from 'path';
import { z } from 'zod';
// A value import with no runtime cycle: output-ref imports from schemas only as types.
import {
  canonicalValueText,
  declaredOutputPathsSchema,
  outputPathsFromRootFields,
  type DeclaredOutputPaths,
  type JsonValue,
} from '../output-ref';
import { runStopReasonSchema, type RunStopReason } from './run-terminal-reason';
import { workflowSourceSchema } from './workflow';
import { PACK_SETTING_ORIGINS } from './pack-settings';

/**
 * Keys the sub-run machinery writes into a child run's untyped `metadata` JSONB, and the
 * shape of each value. `metadata` is `Record<string, unknown>`, so a typo in a string
 * literal at either end silently no-ops — the write lands under a key nobody reads, or the
 * read returns undefined and the child looks like it was never stamped. Naming them once
 * gives the compiler the only handle it can have on an untyped column: writer and reader
 * now share a symbol instead of agreeing by luck.
 *
 * `parent_node_id` — creation-only spawning node (both 1:1 and fan-out); null for a
 *                    child created without a node ID. Its presence survives parent deletion.
 * `child_index`    — the fan-out instance's position in the item list; ABSENT on a 1:1
 *                    child, which is what distinguishes the two on re-entry.
 * `fan_out_item_hash` — hash of the item the child was spawned with, so a resume can warn
 *                    when a non-deterministic producer changed it under the same index.
 * `inputs`         — the resolved `with:` map as canonical TEXT (name → string), persisted
 *                    at spawn so the child's `$INPUTS.<name>` reconstitutes on a cold
 *                    resume without re-resolving parent refs that may be out of scope
 *                    (#2470). Kept string-valued forever: shipped binaries read a
 *                    non-string map as corrupt/unset, so widening it in place would make
 *                    an older binary resuming a newer run lose ALL inputs.
 * `inputs_values`  — additive sibling of `inputs` (#2637): the same map with its LOGICAL
 *                    JSON values, written only when any value is non-string. Readers
 *                    prefer it; its absence degrades to the text map — exactly the old
 *                    behavior, which is what keeps old rows and old binaries correct.
 * `summary_value`  — additive sibling of `summary` (#2637): the child's terminal
 *                    structured value, stamped at completion alongside the text summary
 *                    so a parent `workflow:` node threads the logical value back.
 * `summary_value_null` — `true` when the child's terminal value is JSON null. A
 *                    metadata patch removes a top-level key whose value is null, so a
 *                    null result cannot be stored as `summary_value`; without this marker
 *                    the parent would fall back to the text summary "null". Written only
 *                    for null, so every other result is stored and read as before.
 * `summary_declared_output_paths` — additive sibling of `summary_value`: the field
 *                    paths the child's selected `returns:` node declared, so a parent
 *                    reads `$<node>.output.a.b` under the CHILD's contract — a
 *                    `workflow:` node cannot declare a schema of its own. Only the
 *                    derived projection travels; the schema itself stays in captured
 *                    workflow source. Absent on schemaless children.
 * `summary_declared_fields` — the top-level fields of the same contract (#2453), still
 *                    written for older binaries. A row that has only this key reads as
 *                    a depth-1 path contract.
 */
export const SUBRUN_METADATA_KEYS = {
  parentNodeId: 'parent_node_id',
  childIndex: 'child_index',
  fanOutItemHash: 'fan_out_item_hash',
  inputs: 'inputs',
  inputsValues: 'inputs_values',
  summaryValue: 'summary_value',
  summaryValueNull: 'summary_value_null',
  summaryDeclaredFields: 'summary_declared_fields',
  summaryDeclaredOutputPaths: 'summary_declared_output_paths',
} as const;

/**
 * A run's resolved `$INPUTS` as the two keys a row stores them under: `inputs` as canonical
 * text, kept string-valued for older binaries, and the logical map in `inputs_values` when
 * any value is not a string (or when `keepValues` says the row already carries one, which
 * a text-only write would leave stale, since readers prefer it).
 */
export function runInputsMetadata(
  inputs: Record<string, JsonValue>,
  keepValues = false
): Record<string, unknown> {
  return {
    [SUBRUN_METADATA_KEYS.inputs]: Object.fromEntries(
      Object.entries(inputs).map(([k, v]) => [k, canonicalValueText(v)])
    ),
    ...(keepValues || Object.values(inputs).some(v => typeof v !== 'string')
      ? { [SUBRUN_METADATA_KEYS.inputsValues]: inputs }
      : {}),
  };
}

/** A child's terminal value as completion stamps it; a null value becomes the null marker. */
export function subrunSummaryMetadata(value: unknown): Record<string, unknown> {
  return value === null
    ? { [SUBRUN_METADATA_KEYS.summaryValueNull]: true }
    : { [SUBRUN_METADATA_KEYS.summaryValue]: value };
}

/**
 * The value `subrunSummaryMetadata` stamped, or undefined when none was. Presence-keyed
 * rather than truthiness: `false`/`0` are legitimate values. A merge never keeps a null
 * `summary_value`, so the marker restores it.
 */
function readSubrunSummaryValue(metadata: Record<string, unknown> | undefined): unknown {
  if (metadata === undefined) return undefined;
  if (Object.hasOwn(metadata, SUBRUN_METADATA_KEYS.summaryValue)) {
    return metadata[SUBRUN_METADATA_KEYS.summaryValue];
  }
  return metadata[SUBRUN_METADATA_KEYS.summaryValueNull] === true ? null : undefined;
}

/** Parent deletion clears the foreign key; this creation-only key preserves child provenance. */
export function initialRunMetadata(
  metadata: Record<string, unknown> | undefined,
  parentRunId: string | undefined
): Record<string, unknown> {
  if (parentRunId === undefined) return mutableRunMetadata(metadata);
  const parentNodeId = metadata?.[SUBRUN_METADATA_KEYS.parentNodeId];
  return {
    ...metadata,
    [SUBRUN_METADATA_KEYS.parentNodeId]: typeof parentNodeId === 'string' ? parentNodeId : null,
  };
}

/** Store patches cannot alter child provenance, including on terminal and gate writes. */
export function mutableRunMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  const patch = { ...metadata };
  delete patch[SUBRUN_METADATA_KEYS.parentNodeId];
  return patch;
}

/** Typed view of the sub-run keys on a run's metadata; each is undefined when unset. */
export function readSubrunMetadata(metadata: Record<string, unknown> | undefined): {
  parentNodeId: string | undefined;
  childIndex: number | undefined;
  fanOutItemHash: string | undefined;
  inputs: Record<string, JsonValue> | undefined;
  summaryValue: unknown;
  summaryDeclaredOutputPaths: DeclaredOutputPaths | undefined;
} {
  const parentNodeId = metadata?.[SUBRUN_METADATA_KEYS.parentNodeId];
  const childIndex = metadata?.[SUBRUN_METADATA_KEYS.childIndex];
  const fanOutItemHash = metadata?.[SUBRUN_METADATA_KEYS.fanOutItemHash];
  const asPlainObject = (raw: unknown): Record<string, unknown> | undefined =>
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  // Prefer the logical map (#2637); fall back to the legacy text map, accepting only a
  // plain object of string values there — the legacy writer always stored strings, so a
  // non-conforming value is corrupt/foreign metadata, not a shape to coerce.
  // SQLite's dialect merge (json_patch, RFC 7396) deletes any null-valued interior key,
  // so a logical map that held nulls loses them when merged (#5939). The text map keeps
  // them (as "null"), so keys in the text map that are absent from the logical map are
  // restored as null rather than dropped.
  // Metadata is DB-round-tripped JSON, so a plain object here can only hold JSON
  // values — the casts assert what the storage layer already guarantees.
  const rawValues = asPlainObject(metadata?.[SUBRUN_METADATA_KEYS.inputsValues]) as
    | Record<string, JsonValue>
    | undefined;
  const rawLegacy = asPlainObject(metadata?.[SUBRUN_METADATA_KEYS.inputs]);
  const legacyInputs =
    rawLegacy !== undefined && Object.values(rawLegacy).every(v => typeof v === 'string')
      ? (rawLegacy as Record<string, string>)
      : undefined;
  const inputs =
    rawValues !== undefined
      ? legacyInputs !== undefined
        ? {
            ...Object.fromEntries(
              Object.keys(legacyInputs)
                .filter(k => !Object.hasOwn(rawValues, k))
                .map(k => [k, null])
            ),
            ...rawValues,
          }
        : rawValues
      : legacyInputs;
  // A path contract this binary wrote must parse; a malformed one fails rather than
  // authorizing nothing. A legacy field projection is only usable as a contract when it
  // is exactly an array of strings; anything else degrades to "no contract".
  const rawDeclaredFields = metadata?.[SUBRUN_METADATA_KEYS.summaryDeclaredFields];
  const summaryDeclaredOutputPaths =
    metadata && Object.hasOwn(metadata, SUBRUN_METADATA_KEYS.summaryDeclaredOutputPaths)
      ? declaredOutputPathsSchema.parse(metadata[SUBRUN_METADATA_KEYS.summaryDeclaredOutputPaths])
      : Array.isArray(rawDeclaredFields) && rawDeclaredFields.every(f => typeof f === 'string')
        ? outputPathsFromRootFields(rawDeclaredFields)
        : undefined;
  return {
    parentNodeId: typeof parentNodeId === 'string' ? parentNodeId : undefined,
    childIndex: typeof childIndex === 'number' ? childIndex : undefined,
    fanOutItemHash: typeof fanOutItemHash === 'string' ? fanOutItemHash : undefined,
    inputs,
    summaryValue: readSubrunSummaryValue(metadata),
    summaryDeclaredOutputPaths,
  };
}

/**
 * The result a top-level run that declares `returns.asks` completed with: the value its
 * terminal record holds as `returns` (see `recordedReturn`). Written only by the completing write, and only when the value is
 * defined, so an asks-settled binding can read the run's result once its asks settle,
 * long after the process that held its node outputs has exited.
 *
 * Stored as JSON text, not as a JSON value: older binaries merged SQLite metadata with
 * `json_patch`, which deletes every null-valued key at any depth, so they wrote it as text
 * and read only text. Write it with `asksResultMetadata` and read it with `readAsksResult`.
 */
const ASKS_RESULT_METADATA_KEY = 'asks_result';

/** The metadata that keeps a run's `returns:` value for its asks-settled bindings. */
export function asksResultMetadata(value: JsonValue): Record<string, string> {
  return { [ASKS_RESULT_METADATA_KEY]: JSON.stringify(value) };
}

/** The `returns:` value kept by `asksResultMetadata`, or undefined when none was kept. */
export function readAsksResult(metadata: Record<string, unknown>): JsonValue | undefined {
  const text = metadata[ASKS_RESULT_METADATA_KEY];
  return typeof text === 'string' ? (JSON.parse(text) as JsonValue) : undefined;
}

/**
 * Set by the completing write of a top-level run on an item that stopped the item: it
 * completed with a declared outcome that is not final (`returns.final`), its end started
 * nothing, and it left no ask or wait. The attention queue lists the item as `stopped`
 * while this run is the newest on it. `summary` is the declared `returns.summary` value,
 * or null. Older binaries read metadata as an open record and ignore the key.
 *
 * Admission also sets it, with `limit`, on the completed run whose end or settled asks
 * caused a start it refused at the start's limit (see `stoppedLimitSchema`): that start
 * was the item's next step, so nothing follows the run either. An older binary reads that
 * stop without its limit. Preparation sets it the same way, with `refused`, when it rejects
 * such a start before launch (see `stoppedRefusalSchema`).
 */
export const ITEM_STOPPED_METADATA_KEY = 'item_stopped';

/** The longest summary kept, so one line in attention stays one line. */
const ITEM_STOPPED_SUMMARY_MAX = 500;

/**
 * The start limit that stopped an item: where it stood when admission refused the start
 * (`left` was 0), and the binding and workflow the refused start was for, so a reader can
 * name what raises it.
 */
export const stoppedLimitSchema = z.object({
  name: z.string(),
  starts: z.number().int().positive(),
  granted: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  bindingId: z.string(),
  workflow: z.string(),
});
export type StoppedLimit = z.infer<typeof stoppedLimitSchema>;

/**
 * Why a start was refused before launch. At the hand-off a run's end or settled asks make:
 * the checkout could not be handed on (`checkout_refused`), a mapped input named nothing
 * (`inputs_unmapped`), or the items it links to could not be read or hold no such link
 * (`link_refused`). In preparation: the cause when the engine types it
 * (`no_default_provider`, or `file_setting_missing` when a pack `file: true` setting the
 * workflow reads names no file), else the stage that failed, as the binding's `error`
 * stores it. Never the exception text, which can hold secret values.
 */
export const startRefusalReasonSchema = z.enum([
  'checkout_refused',
  'inputs_unmapped',
  'link_refused',
  'no_default_provider',
  'file_setting_missing',
  'run_as_user_failed',
  'run_configuration_failed',
  'launch_preparation_failed',
]);
export type StartRefusalReason = z.infer<typeof startRefusalReasonSchema>;

/**
 * A binding a run's end or settled asks refused at the hand-off: the workflow it would have
 * started and why, carried on the evaluated binding for the stop on that run. Not stored.
 */
export const handoffRefusalSchema = z.object({
  workflow: z.string(),
  reason: startRefusalReasonSchema,
});

/**
 * The pack setting a `file_setting_missing` refusal is about: its name, the path that was
 * checked, and where the value came from. Project configuration, not exception text.
 */
export const fileSettingRefusalSchema = z.object({
  setting: z.string(),
  path: z.string(),
  origin: z.enum(PACK_SETTING_ORIGINS),
});
export type FileSettingRefusal = z.infer<typeof fileSettingRefusalSchema>;

/**
 * A start refused before launch: its receipt and binding (`archon trigger inspect`), the
 * workflow it was for, why, and when. `fileSetting` is set with `file_setting_missing`.
 */
export const stoppedRefusalSchema = z.object({
  receiptId: z.string(),
  bindingId: z.string(),
  workflow: z.string(),
  reason: startRefusalReasonSchema,
  refusedAt: z.string(),
  fileSetting: fileSettingRefusalSchema.optional(),
});
export type StoppedRefusal = z.infer<typeof stoppedRefusalSchema>;

/** A recorded stop: why the run stopped its item, and the starts its end caused that were refused. */
export interface ItemStopped {
  summary: string | null;
  limit?: StoppedLimit;
  /** Every start refused before launch, one per binding, in the order they were refused. */
  refused?: StoppedRefusal[];
}

/** The metadata that marks a completed run as having stopped its item. */
export function itemStoppedMetadata(
  summary: string | null,
  refusals: Omit<ItemStopped, 'summary'> = {}
): Record<string, unknown> {
  const line = summary?.trim().slice(0, ITEM_STOPPED_SUMMARY_MAX) ?? '';
  return { [ITEM_STOPPED_METADATA_KEY]: { summary: line === '' ? null : line, ...refusals } };
}

/** The stop a completed run recorded, or undefined when it stopped nothing. */
export function readItemStopped(metadata: Record<string, unknown>): ItemStopped | undefined {
  const value = metadata[ITEM_STOPPED_METADATA_KEY];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { summary, limit, refused } = value as Record<string, unknown>;
  // A newer binary may add keys or reasons; an entry that does not read is dropped, not refused.
  const readLimit = stoppedLimitSchema.safeParse(limit);
  const readRefused = (Array.isArray(refused) ? refused : []).flatMap(entry => {
    const read = stoppedRefusalSchema.safeParse(entry);
    return read.success ? [read.data] : [];
  });
  return {
    summary: typeof summary === 'string' ? summary : null,
    ...(readLimit.success ? { limit: readLimit.data } : {}),
    ...(readRefused.length > 0 ? { refused: readRefused } : {}),
  };
}

export const CANCELLED_REASON_METADATA_KEY = 'cancelled_reason';

export const ISOLATION_ENV_ID_METADATA_KEY = 'isolation_env_id';

export const CONTAINER_ISOLATION_MARKER = { key: 'isolation', value: 'container' } as const;

/**
 * Keys the run-lifecycle machinery writes into a row's untyped `metadata` JSONB, and the
 * shape of each value. `metadata` is `Record<string, unknown>`, so a typo in a string
 * literal at either end silently no-ops — the write lands under a key nobody reads, or the
 * read returns undefined and the row looks like it was never stamped. Naming them once
 * gives the compiler the only handle it can have on an untyped column: writer and reader
 * now share a symbol instead of agreeing by luck.
 *
 * `identity_unresolved` — TRUE on a fresh run whose `output_root` was deliberately NOT
 *                       written because `resolveProjectPaths` returned the `@cwd/<basename>-<digest>`
 *                       fallback AFTER `getCodebase` threw on both retry attempts (#2304).
 *                       Distinguishes "this run is on the cwd fallback because the codebase
 *                       had no owner/repo or `_local` identity" (legitimate, the WARN arm
 *                       of the same function) from "this run is on the cwd fallback
 *                       because we couldn't reach the registry at all" (the ERROR arm).
 *                       Absent on every other run — the existing `output_root` write-once
 *                       invariant is preserved for them. Cleared by the same persistence
 *                       block the moment a later resume writes a real root, so a row that
 *                       heals stops reading as faulted.
 */
export const RUN_METADATA_KEYS = {
  identityUnresolved: 'identity_unresolved',
} as const;

/**
 * Between-run continuation (#2747). Written once at run creation alongside
 * `adopted_from_run_id`: `{mode: 'adopt'}` when this run took over a terminal
 * run's estate, `{mode: 'supersede'}` when a fresh-lane rerun replaces its open
 * item (NO lane inheritance). Execution uses the stamp to select inheritance.
 */
export const CONTINUATION_METADATA_KEY = 'continuation';

export const CONTINUATION_MODES = { adopt: 'adopt', supersede: 'supersede' } as const;
export type ContinuationMode = (typeof CONTINUATION_MODES)[keyof typeof CONTINUATION_MODES];
const continuationMetadataSchema = z.object({ mode: z.enum(Object.values(CONTINUATION_MODES)) });
export type ContinuationMetadata = z.infer<typeof continuationMetadataSchema>;

export function continuationInheritsEstate(mode: ContinuationMode): boolean {
  switch (mode) {
    case CONTINUATION_MODES.adopt:
      return true;
    case CONTINUATION_MODES.supersede:
      return false;
  }
  return mode satisfies never;
}

/** Unstamped legacy runs retain adoption behavior; malformed stamps must not select an estate. */
export function readContinuationMode(
  metadata: Record<string, unknown> | undefined
): ContinuationMode | undefined {
  if (!metadata || !Object.hasOwn(metadata, CONTINUATION_METADATA_KEY)) return undefined;
  const parsed = continuationMetadataSchema.safeParse(metadata[CONTINUATION_METADATA_KEY]);
  if (!parsed.success) throw new Error('Invalid recorded continuation metadata.');
  return parsed.data.mode;
}

/**
 * The host, process and user that last took over executing this run. The store writes it
 * in the same update that makes the run `running` for that process (a pending claim or a
 * resume, `currentExecutionOwner`), so no reader sees a new claim beside the previous
 * owner. The live-owner endpoint is local to one host and one user, so when no owner
 * answers, this record is what `abandon` shows the operator, including whether the owner
 * ran on another host or as another user. It is a report, never a liveness signal:
 * nothing decides a run is dead from it. `workflow wait` and resume read its host and uid
 * only to refuse when this host and user could not reach that owner's endpoint.
 */
export const EXECUTION_OWNER_METADATA_KEY = 'execution_owner';

export interface ExecutionOwnerRecord {
  host: string;
  pid: number;
  /** POSIX user id; absent on Windows, where the endpoint is not scoped by uid. */
  uid?: number;
}

/** Typed view of the execution-owner stamp; undefined on runs that predate it. */
export function readExecutionOwner(
  metadata: Record<string, unknown> | undefined
): ExecutionOwnerRecord | undefined {
  return readOwnerRecord(metadata?.[EXECUTION_OWNER_METADATA_KEY]);
}

function readOwnerRecord(raw: unknown): ExecutionOwnerRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { host, pid, uid } = raw as { host?: unknown; pid?: unknown; uid?: unknown };
  if (typeof host !== 'string' || host.length === 0) return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  return typeof uid === 'number' && Number.isInteger(uid) && uid >= 0
    ? { host, pid, uid }
    : { host, pid };
}

/**
 * How the hand-off of an admitted start ended, written by the process that handed it over
 * while the run is still `pending`. `handed_off` names the process the start was handed
 * to: a detached `trigger execute`, or a server running it in-process. `hand_off_failed`
 * records that the hand-off started nothing. It is evidence for a reader while the run
 * waits for its executor's claim, never a liveness signal: a live pid is not proof that
 * the process is still this executor, and only the live-owner endpoint proves that. What
 * it can prove is absence: a failed hand-off, or a recorded process that no longer exists.
 * Once the executor claims the run, `execution_owner` takes over and this key is inert.
 */
export const START_EXECUTOR_METADATA_KEY = 'start_executor';

export type StartExecutorRecord =
  | ({ kind: 'handed_off' } & ExecutionOwnerRecord)
  | { kind: 'hand_off_failed' };

/** Typed view of the start-executor record; undefined when none was written or it does not read. */
export function readStartExecutor(
  metadata: Record<string, unknown> | undefined
): StartExecutorRecord | undefined {
  const raw = metadata?.[START_EXECUTOR_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { kind } = raw as { kind?: unknown };
  if (kind === 'hand_off_failed') return { kind };
  const owner = kind === 'handed_off' ? readOwnerRecord(raw) : undefined;
  return owner === undefined ? undefined : { kind: 'handed_off', ...owner };
}

/** Typed view of the run-lifecycle keys on a run's metadata; undefined when unset. */
export function readIdentityUnresolved(
  metadata: Record<string, unknown> | undefined
): boolean | undefined {
  const raw = metadata?.[RUN_METADATA_KEYS.identityUnresolved];
  return typeof raw === 'boolean' ? raw : undefined;
}

/**
 * Key under which a run records WHY it stopped (#3479).
 *
 * A stopped run's status says `failed`, which in this codebase also means
 * "resumable" — so an operator who pressed Ctrl-C sees the same row as an
 * operator whose workflow broke. The categorical cause is already durable in the
 * terminal `workflow_failed` event's `exit_reason`, but no operator surface reads
 * events for it: `workflow get` reads the run row, and the console's list endpoint
 * returns run rows with no events at all. This key is the same fact on the row,
 * so both read it without a second mechanism each.
 *
 * Written by the process that owns the run, from the signal it received. Cleared
 * by `resumeWorkflowRun`, so a resumed-and-completed run does not go on claiming
 * it was interrupted. Absent on runs that stopped before this key existed.
 */
export const RUN_STOP_REASON_METADATA_KEY = 'stop_reason';

/** Typed view of the stop reason; undefined when the run carries none this build can read. */
export function readRunStopReason(
  metadata: Record<string, unknown> | undefined
): RunStopReason | undefined {
  const parsed = runStopReasonSchema.safeParse(metadata?.[RUN_STOP_REASON_METADATA_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Key under which a paused run that gave back its resource slot records that its
 * continuation was refused for capacity (#4045): `{ since }`, the first refusal. The run
 * is then a capacity waiter: it keeps its place ahead of queued new starts, ordered by
 * `since`, so a later refusal keeps the first value. Cleared by `resumeWorkflowRun` and by
 * `releasePausedRunSlot`, so a later pause never inherits it.
 */
export const CAPACITY_WAIT_METADATA_KEY = 'capacity_wait';

const capacityWaitSchema = z.object({ since: z.string() });

/** Typed view of the capacity wait; undefined when the run carries none this build can read. */
export function readCapacityWait(
  metadata: Record<string, unknown> | undefined
): z.infer<typeof capacityWaitSchema> | undefined {
  const parsed = capacityWaitSchema.safeParse(metadata?.[CAPACITY_WAIT_METADATA_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Key under which a run released after this host could not read its frozen source
 * (#4209) records where it stopped: `{ nodeId, releaseId, releasedAt, path? }`. Written by
 * `releaseRunForUnreadableSource`, cleared by `resumeWorkflowRun`. It makes the paused
 * run a due `source` continuation, so any host that can read the source continues it.
 */
export const SOURCE_RELEASE_METADATA_KEY = 'source_release';

const sourceReleaseSchema = z.object({
  nodeId: z.string().min(1),
  releaseId: z.string().uuid().optional(),
  releasedAt: z.string().datetime({ offset: true }),
  path: z.string().optional(),
});

export type SourceRelease = z.infer<typeof sourceReleaseSchema>;

/** Typed view of the source release; undefined when the run carries none this build can read. */
export function readSourceRelease(
  metadata: Record<string, unknown> | undefined
): SourceRelease | undefined {
  const parsed = sourceReleaseSchema.safeParse(metadata?.[SOURCE_RELEASE_METADATA_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Key under which a run records what its DISPATCHING surface resolved for it (#2454).
 *
 * A resume re-enters the executor with whatever the resuming surface happens to hold,
 * and the in-process auto-resume after a child gate holds nothing at all. Re-resolving
 * these from the environment then lets a run change what it is halfway through: the
 * same `$BASE_BRANCH` reference answers a different branch after the gate than before
 * it, and a bundled workflow starts reporting itself as custom. Written once when the
 * run starts and read back on every continuation, so the run keeps the answers it
 * began with. Absent on runs created before this key existed — those continue to
 * re-resolve, which is the behavior they have always had.
 */
export const RUN_DISPATCH_METADATA_KEY = 'dispatch';

export const runDispatchMetadataSchema = z.object({
  /** The resolved `$BASE_BRANCH`. Empty string is a real outcome (folder projects, and
   *  repos where auto-detection failed), which is why absence is carried by the key. */
  base_branch: z.string(),
  /** Discovery source, for run attribution and telemetry categorization. */
  source: workflowSourceSchema.optional(),
  /**
   * Key of the pack the run's workflow was loaded from; absent for a flat workflow. How a
   * run knows its pack: a continuation carries it forward, and reporting where each of a
   * run's settings came from reads it.
   */
  pack: z.string().min(1).optional(),
  /**
   * The workflow's name within that pack: its authored `name:`, the same for a project copy
   * and an installed copy (`WorkflowPackMember.workflow`). Recorded with `pack`; absent on
   * rows from older builds.
   */
  pack_workflow: z.string().min(1).optional(),
  /**
   * Written by every fresh run: the row's `inputs` are the run's complete, fixed `$INPUTS`
   * (pack settings, declared defaults, supplied values), so a resume layers no declared
   * defaults over them. Absent on rows from older builds.
   */
  inputs_resolved: z.literal(true).optional(),
  /**
   * Names of the inputs the run was supplied with (`--input`, the run route's `inputs`, a
   * parent's `with:`), as opposed to the pack settings and declared defaults `inputs` also
   * holds. A re-run restores only these, so an unsupplied input keeps taking its default.
   * Absent on rows from older builds.
   */
  supplied_inputs: z.array(z.string()).optional(),
});

export type RunDispatchMetadata = z.infer<typeof runDispatchMetadataSchema>;

/** Typed view of the dispatch stamp; undefined when the run carries none this build can read. */
export function readRunDispatchMetadata(
  metadata: Record<string, unknown> | undefined
): RunDispatchMetadata | undefined {
  const parsed = runDispatchMetadataSchema.safeParse(metadata?.[RUN_DISPATCH_METADATA_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The inputs a run was invoked with, as text by name: what re-running it supplies again.
 * Empty for a run whose dispatch record names none, including every run started before
 * the record did. Reads the canonical text map only, so a run list never depends on the
 * rest of a row's sub-run metadata parsing.
 */
export function readSuppliedRunInputs(
  metadata: Record<string, unknown> | undefined
): Record<string, string> {
  const names = readRunDispatchMetadata(metadata)?.supplied_inputs ?? [];
  const text = metadata?.[SUBRUN_METADATA_KEYS.inputs];
  if (typeof text !== 'object' || text === null) return {};
  const supplied: Record<string, string> = {};
  for (const name of names) {
    const value: unknown = Object.hasOwn(text, name)
      ? (text as Record<string, unknown>)[name]
      : undefined;
    if (typeof value === 'string') supplied[name] = value;
  }
  return supplied;
}

/**
 * Key under which a run records the executable SOURCE it was started from.
 *
 * A run reads its workflows, commands, and scripts from one directory and acts on
 * another. Recording the first is what lets a resume reach the same source a month
 * later, from a different process, after the authoring checkout has moved on. Absent
 * on runs created before source capture existed, and on runs whose source could not
 * be captured — both resolve live, which is exactly the pre-capture behavior.
 */
export const WORKFLOW_SOURCE_METADATA_KEY = 'workflow_source';

/** Source-side settings that decide which executable files a workflow resolves. */
export const workflowSourceConfigSchema = z.object({
  load_default_workflows: z.boolean(),
  load_default_commands: z.boolean(),
  command_folder: z.string().optional(),
  /**
   * Names (never values) from `.archon/config.yaml`'s `env:` section at capture time —
   * the exec env-read checker's "this name is configured" signal for a resumed or
   * child run, which discovers against the frozen capture rather than live config.
   */
  env_var_names: z.array(z.string()).optional(),
});

export type WorkflowSourceConfig = Readonly<z.infer<typeof workflowSourceConfigSchema>>;

const absolutePathSchema = z
  .string()
  .refine(p => isAbsolute(p), { message: 'must be an absolute path' });

/**
 * Where a run's project definitions (workflows, commands, scripts, an in-repository pack,
 * `.archon/config.yaml`) came from.
 *
 * - `base`: the base branch commit fetched at the start, with the files uncommitted in the
 *   operator's checkout laid on top. `local_files` names every file taken from the
 *   checkout. The capture holds the project config, under `project/.archon/config.yaml`.
 *   A child of such a run records its parent's and adds `run_files`.
 * - `checkout`: an in-place run reads its checkout as it is; the checkout is its one commit.
 * - `source`: an explicit source (`--workflow-source`, `launch.discoveryCwd`), read as it is.
 */
const definitionFilesSchema = z.array(
  z.object({
    path: z.string().min(1),
    change: z.enum(['modified', 'added', 'deleted', 'ignored']),
  })
);

export const runDefinitionsSchema = z.discriminatedUnion('from', [
  z.object({
    from: z.literal('base'),
    /** Absent when the repository has no remote: the base is then a local branch. */
    remote: z.string().min(1).optional(),
    branch: z.string().min(1),
    commit: z.string().min(1),
    merge_base: z.string().min(1),
    checkout: absolutePathSchema,
    local_files: definitionFilesSchema,
    /**
     * A `workflow:` child's own layer: the definition files its parent's execution
     * checkout changed since the parent started, laid on the parent's captured
     * definitions when the child started. Absent on a run that is not such a child.
     */
    run_files: z
      .object({
        checkout: absolutePathSchema,
        since: z.string().min(1),
        files: definitionFilesSchema,
      })
      .optional(),
  }),
  z.object({ from: z.literal('checkout'), checkout: absolutePathSchema }),
  z.object({ from: z.literal('source'), root: absolutePathSchema }),
]);

export type RunDefinitions = z.infer<typeof runDefinitionsSchema>;
export type BaseRunDefinitions = Extract<RunDefinitions, { from: 'base' }>;

/**
 * A run's recorded executable source.
 *
 * `version` exists so a future capture layout can be recognized rather than
 * misread. An unrecognized record fails closed: only a run with no source record
 * may resume against live discovery.
 */
export const workflowSourceMetadataSchema = z.object({
  version: z.literal(1),
  /**
   * Absolute path to the captured source; usable directly as a project root.
   *
   * Absoluteness is enforced rather than assumed: every root reaching here is built from
   * the run's own workspace path, so a relative or blank one means the record is corrupt
   * or foreign. Resolving it against whatever `process.cwd()` happens to be would send
   * every command and script lookup somewhere arbitrary, so the record is unreadable.
   */
  root: z.string().refine(p => isAbsolute(p), { message: 'must be an absolute path' }),
  /** The authoring directory a not-yet-started child captures from. */
  origin: z.string().refine(p => isAbsolute(p), { message: 'must be an absolute path' }),
  captured_at: z.string(),
  /**
   * Content digest of the capture, mirrored from its manifest.
   *
   * Duplicated onto the run row on purpose: it is what lets a reader inspect a run's
   * source identity — and compare two runs — without touching the capture directory,
   * which may since have been reclaimed. Verification still reads the manifest.
   */
  digest: z.string(),
  /**
   * Resolution settings pinned beside the digest, outside the mutable capture.
   * Optional only for runs created before this field shipped.
   */
  source_config: workflowSourceConfigSchema.optional(),
  file_count: z.number(),
  byte_count: z.number(),
  /**
   * Absent on runs created before definitions were recorded, on chat and web runs, on
   * adopted lanes, and on children of a parent without base-branch definitions.
   */
  definitions: runDefinitionsSchema.optional(),
});

export type WorkflowSourceMetadata = z.infer<typeof workflowSourceMetadataSchema>;

/**
 * What a run says about its executable source.
 *
 * Three states, and collapsing any two of them is a correctness bug:
 *
 *  - `absent` — the run predates source capture. It has nothing to honor, so it may
 *    resume against live source. This is the ONLY tolerable fallback.
 *  - `recorded` — the run froze source and named it. That source, or nothing.
 *  - `unreadable` — the run recorded SOMETHING this build cannot parse: a corrupt value,
 *    a hand edit, or a future format. Emphatically not the same as `absent`. Treating it
 *    as absent would resume the run against whatever is on disk now, which is exactly
 *    what a run that recorded its source must never do.
 */
export type WorkflowSourceState =
  | { kind: 'absent' }
  | { kind: 'recorded'; record: WorkflowSourceMetadata }
  | { kind: 'unreadable'; detail: string };

export function readWorkflowSourceState(
  metadata: Record<string, unknown> | undefined
): WorkflowSourceState {
  const raw = metadata?.[WORKFLOW_SOURCE_METADATA_KEY];
  if (raw === undefined) return { kind: 'absent' };
  const parsed = workflowSourceMetadataSchema.safeParse(raw);
  return parsed.success
    ? { kind: 'recorded', record: parsed.data }
    : { kind: 'unreadable', detail: parsed.error.message };
}

/**
 * True when `run` executed inside an isolation container.
 *
 * Such a run can only be resumed where the docker backend is reachable and the
 * container can be rewired — the CLI. `executeWorkflow` enforces this: a resume
 * without a container context fails the run with a CLI pointer rather than
 * silently running host-side and dropping the write-back. Callers that offer to
 * continue a run consult this FIRST so they never promise a continuation the
 * executor will refuse (#2565). Reads defensively from possibly-absent metadata.
 */
export function isContainerRun(run: { metadata?: Record<string, unknown> }): boolean {
  return run.metadata?.[CONTAINER_ISOLATION_MARKER.key] === CONTAINER_ISOLATION_MARKER.value;
}

export const ownedWorktreeSchema = z
  .object({
    envId: z.string().min(1),
    creationId: z.string().uuid(),
  })
  .strict();
export type OwnedWorktree = z.infer<typeof ownedWorktreeSchema>;

export function readOwnedWorktree(
  metadata: Record<string, unknown> | undefined
): OwnedWorktree | undefined {
  const result = ownedWorktreeSchema.safeParse(metadata?.owned_worktree);
  return result.success ? result.data : undefined;
}
