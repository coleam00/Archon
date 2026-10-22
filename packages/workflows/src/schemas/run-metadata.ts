/**
 * Keys the engine writes into a run row's untyped `metadata` JSONB, each with the typed
 * reader that is the only way to read it back.
 */
import { isAbsolute } from 'path';
import { z } from 'zod';
import {
  declaredOutputPathsSchema,
  outputPathsFromRootFields,
  type DeclaredOutputPaths,
} from '../output-ref';
// Type-only, so the output-ref ↔ schemas edge stays erased (no runtime cycle).
import type { JsonValue } from '../output-ref';
import { runStopReasonSchema, type RunStopReason } from './run-terminal-reason';
import { workflowSourceSchema } from './workflow';

/**
 * Keys the sub-run machinery writes into a child run's untyped `metadata` JSONB, and the
 * shape of each value. `metadata` is `Record<string, unknown>`, so a typo in a string
 * literal at either end silently no-ops — the write lands under a key nobody reads, or the
 * read returns undefined and the child looks like it was never stamped. Naming them once
 * gives the compiler the only handle it can have on an untyped column: writer and reader
 * now share a symbol instead of agreeing by luck.
 *
 * `parent_node_id` — which node of the parent spawned this child (both 1:1 and fan-out).
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
  summaryDeclaredFields: 'summary_declared_fields',
  summaryDeclaredOutputPaths: 'summary_declared_output_paths',
} as const;

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
    inputs: rawValues ?? legacyInputs,
    // Presence-keyed rather than truthiness: `false`/`0`/`null` are legitimate values.
    summaryValue:
      metadata !== undefined && Object.hasOwn(metadata, SUBRUN_METADATA_KEYS.summaryValue)
        ? metadata[SUBRUN_METADATA_KEYS.summaryValue]
        : undefined,
    summaryDeclaredOutputPaths,
  };
}

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
 * item (NO lane inheritance). Lives in metadata, not a column — nothing queries
 * it except display.
 */
export const CONTINUATION_METADATA_KEY = 'continuation';

export type ContinuationMode = 'adopt' | 'supersede';

/** Typed view of the continuation stamp; undefined when the run adopted nothing. */
export function readContinuationMode(
  metadata: Record<string, unknown> | undefined
): ContinuationMode | undefined {
  const raw = metadata?.[CONTINUATION_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const mode = (raw as { mode?: unknown }).mode;
  return mode === 'adopt' || mode === 'supersede' ? mode : undefined;
}

/**
 * The host, process and user that last took over executing this run, stamped by the
 * executor each time it starts or resumes execution. The live-owner endpoint is
 * local to one host and one user, so when no owner answers, this record is what
 * `abandon` shows the operator, including whether the owner ran on another host or
 * as another user. It is a report, never a liveness signal: nothing decides a run is
 * dead from it. `workflow wait` reads its host and uid only to refuse reporting owner
 * loss when this host and user could not reach that owner's endpoint.
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
  const raw = metadata?.[EXECUTION_OWNER_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { host, pid, uid } = raw as { host?: unknown; pid?: unknown; uid?: unknown };
  if (typeof host !== 'string' || host.length === 0) return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  return typeof uid === 'number' && Number.isInteger(uid) && uid >= 0
    ? { host, pid, uid }
    : { host, pid };
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
  return run.metadata?.isolation === 'container';
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
