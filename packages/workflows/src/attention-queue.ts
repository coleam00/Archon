/**
 * The attention queue: everything that needs someone, as a typed item an answerer outside
 * Archon can list, filter, count and read without parsing prose (#4039).
 *
 * `listAttentionQueue` is the one reader. A paused run is not stored as an item: it is
 * derived into one each time the list is read (`toAttentionQueueItem`), so the run keeps
 * owning its pause. An item may also have no run; `AttentionQueueSource.itemsWithoutRun`
 * is where those come from. Labels are data. The queue filters them by exact match and
 * sorts them as plain strings, and nothing here depends on who is asking.
 */
import {
  isAttentionDegraded,
  splitAttentionRead,
  type AttentionRead,
} from './schemas/attention-degraded';
import { z } from 'zod';
import {
  getRunArtifactsDirForRoot,
  getRunLogPathForRoot,
  isInsideArchonWorkspaces,
  projectKeyForStorageRoot,
  resolveRunStorageRoot,
} from '@archon/paths/archon-paths';
import {
  attentionFormSchema,
  attentionLabelKeySchema,
  attentionLabelsSchema,
  attentionOptionSchema,
  attentionRecommendationSchema,
  type AttentionLabels,
} from './schemas/wait-node';
import {
  attentionLabels,
  attentionRevision,
  pausedAttentionWait,
  pausedUsageLimitWait,
  queuedRunAttention,
  runAttentionUnreadableReasonSchema,
  SUBRUN_METADATA_KEYS,
  workflowItemSchema,
  type QueuedRunAttention,
  type WorkflowItem,
  type WorkflowRun,
} from './schemas/workflow-run';
import { resolveRunAttention } from './run-attention-resolution';
import { stateProjectKeySchema } from './state-document-store';
import type { AttentionQueueCounts } from './attention-counts';
import type { IWorkflowStore } from './store';

/**
 * A project as the engine identifies it. `key` is the identity: the project storage key
 * state documents scope by, so `archon state --project <key>` reaches the same project.
 * `codebaseId` is null when the project has no codebase row, such as a run in an
 * unregistered directory (`@cwd/<basename>-<digest>`). `name` is the codebase's name, or otherwise
 * the key's last segment.
 */
export const projectRefSchema = z.object({
  key: stateProjectKeySchema,
  codebaseId: z.string().nullable(),
  name: z.string().min(1),
});
export type ProjectRef = z.infer<typeof projectRefSchema>;

/** Where a fan-out child sits in its parent: the parent run, the fan-out node, the item index. */
export const fanOutPositionSchema = z.object({
  parentRunId: z.string(),
  nodeId: z.string(),
  index: z.number().int().nonnegative(),
});
export type FanOutPosition = z.infer<typeof fanOutPositionSchema>;

/** Pointers to the context an answerer may read. Paths only, never their content. */
export const attentionQueueContextSchema = z.object({
  artifactsDir: z.string().nullable(),
  transcript: z.string().nullable(),
  workingPath: z.string().nullable(),
  branch: z.string().nullable(),
});

/** The paused run that holds an item: what it is part of and where its context is. */
const heldRunFields = {
  id: z.string(),
  workflow: z.string(),
  /** The run's direct parent run, for every child run; null for a top-level run. */
  parentRunId: z.string().nullable(),
  /** Set when the run is a `fan_out:` child; null for every other run. */
  fanOut: fanOutPositionSchema.nullable(),
  context: attentionQueueContextSchema,
};
/** A run paused at a node for an answer; `occurrence` names this pause of it. */
const answerableRunSchema = z.object({
  ...heldRunFields,
  node: z.string(),
  occurrence: z.string(),
});

const itemBase = {
  /**
   * The item's identity: the one string a surface hands out with an item and takes back
   * to read or answer it. Opaque to every caller.
   */
  ref: z.string().min(1),
  /** Null only when the item's run has no trusted storage root, so there is no key to give. */
  project: projectRefSchema.nullable(),
  /** The item (`workflow run --item`) the work belongs to, when it belongs to one. */
  item: workflowItemSchema.optional(),
  /** 1, plus one for every label write since the item opened. */
  revision: z.number().int().positive(),
  labels: attentionLabelsSchema,
  /** When the item opened; null when its pause records no time (gates). */
  pausedAt: z.string().datetime().nullable(),
};

/**
 * One queue item. `kind` says what it asks: `attention` is a question, answered with
 * `answer`; `awaiting_response` is a gate, answered with `approve`, `reject` or `respond`;
 * `usage_limit` is a run waiting for a provider usage limit, or a rate limit that outlasted
 * its retries, that tries again by itself at `resetAt` (the provider's reported reset, or a
 * computed backoff for a rate limit) and needs no answer; `unreadable` is a paused run
 * nothing can describe, which someone has to look at and resume or abandon.
 *
 * `run` is the paused run that holds the item. A gate, a usage-limit wait and an
 * unreadable pause are always a run. A question may have none: then nothing is paused on
 * it, and its `ref` is all that names it.
 */
export const attentionQueueItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('attention'),
    ...itemBase,
    run: answerableRunSchema.optional(),
    message: z.string(),
    form: attentionFormSchema,
    options: z.array(attentionOptionSchema),
    /** The option with id `other` is the reserved one: an answer choosing it needs text. */
    other: z.literal(true).optional(),
    recommendation: attentionRecommendationSchema.optional(),
  }),
  z.object({
    kind: z.literal('awaiting_response'),
    ...itemBase,
    run: answerableRunSchema,
    message: z.string(),
  }),
  z.object({
    kind: z.literal('usage_limit'),
    ...itemBase,
    run: z.object({ ...heldRunFields, node: z.string() }),
    resetAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal('unreadable'),
    ...itemBase,
    run: z.object(heldRunFields),
    reason: runAttentionUnreadableReasonSchema,
    detail: z.string(),
  }),
]);
export type AttentionQueueItem = z.infer<typeof attentionQueueItemSchema>;
/** An item a paused run holds. */
export type RunAttentionQueueItem = AttentionQueueItem & { run: object };
/** True when a paused run holds `item`; narrows to its `run`. */
export function isHeldByRun(item: AttentionQueueItem): item is RunAttentionQueueItem {
  return item.run !== undefined;
}
/** An item no run holds. */
export type AttentionQueueItemWithoutRun = Extract<AttentionQueueItem, { kind: 'attention' }> & {
  run?: undefined;
};

const RUN_REF_SEPARATOR = ':';

/**
 * The ref of the item a paused run holds: its run and, for an item that takes an answer,
 * the occurrence of its pause, so a ref to an earlier pause of the same run no longer
 * matches. `runIdOfRef` reads it back; nothing else builds or parses one.
 */
function runItemRef(runId: string, occurrence?: string): string {
  return occurrence === undefined ? runId : `${runId}${RUN_REF_SEPARATOR}${occurrence}`;
}

function runIdOfRef(ref: string): string {
  return ref.split(RUN_REF_SEPARATOR, 1)[0] ?? '';
}

/** The run facts an item needs beyond the row, read by the host. */
export interface AttentionQueueItemSources {
  /** The run's codebase row; null when it has none. */
  codebase: { id: string; kind?: string | null; name: string; default_cwd: string } | null;
  /** The branch of the run's checkout, from the host's isolation records. */
  branch: string | null;
  /** The item the run belongs to; null when it belongs to none. */
  item: WorkflowItem | null;
}

/**
 * The project key of a storage root, or null when the root has none: it is outside the
 * workspaces directory, or does not name a project there.
 */
function projectKeyOf(root: string): string | null {
  if (!isInsideArchonWorkspaces(root)) return null;
  const key = stateProjectKeySchema.safeParse(projectKeyForStorageRoot(root));
  return key.success ? key.data : null;
}

/** The project a key names: the codebase's, or one with no codebase row, named by the key. */
export function projectRef(
  key: string,
  codebase: Pick<NonNullable<AttentionQueueItemSources['codebase']>, 'id' | 'name'> | null
): ProjectRef {
  const parsed = stateProjectKeySchema.parse(key);
  return {
    key: parsed,
    codebaseId: codebase?.id ?? null,
    name: codebase?.name ?? parsed.slice(parsed.lastIndexOf('/') + 1),
  };
}

/** The project a run belongs to, from its trusted storage root (`resolveRunStorageRoot`). */
export function projectRefForRun(
  run: Pick<WorkflowRun, 'output_root'>,
  codebase: AttentionQueueItemSources['codebase']
): ProjectRef | null {
  const root = resolveRunStorageRoot(run, codebase);
  const key = root === null ? null : projectKeyOf(root);
  return key === null ? null : projectRef(key, codebase);
}

/** The fan-out position a child run records at spawn, or null when it is not a fan-out child. */
export function fanOutPosition(
  run: Pick<WorkflowRun, 'parent_run_id' | 'metadata'>
): FanOutPosition | null {
  const nodeId = run.metadata[SUBRUN_METADATA_KEYS.parentNodeId];
  const index = run.metadata[SUBRUN_METADATA_KEYS.childIndex];
  return run.parent_run_id !== null &&
    typeof nodeId === 'string' &&
    typeof index === 'number' &&
    Number.isInteger(index) &&
    index >= 0
    ? { parentRunId: run.parent_run_id, nodeId, index }
    : null;
}

/** Derive the queue item `run` holds, from its run-attention `attention`. */
export function toAttentionQueueItem(
  run: WorkflowRun,
  attention: QueuedRunAttention,
  sources: AttentionQueueItemSources
): RunAttentionQueueItem {
  const root = resolveRunStorageRoot(run, sources.codebase);
  const wait = attention.kind === 'attention' ? pausedAttentionWait(run) : undefined;
  const base = {
    project: projectRefForRun(run, sources.codebase),
    ...(sources.item === null ? {} : { item: sources.item }),
    revision: wait === undefined ? 1 : attentionRevision(wait),
    labels: wait === undefined ? {} : attentionLabels(wait),
    pausedAt: (wait ?? pausedUsageLimitWait(run))?.waitingSince ?? null,
  };
  const held = {
    id: run.id,
    workflow: run.workflow_name,
    parentRunId: run.parent_run_id,
    fanOut: fanOutPosition(run),
    context: {
      artifactsDir: root === null ? null : getRunArtifactsDirForRoot(root, run.id),
      transcript: root === null ? null : getRunLogPathForRoot(root, run.id),
      workingPath: run.working_path,
      branch: sources.branch,
    },
  };
  switch (attention.kind) {
    case 'attention':
      return {
        kind: 'attention',
        ref: runItemRef(run.id, attention.occurrence),
        ...base,
        run: { ...held, node: attention.nodeId, occurrence: attention.occurrence },
        message: attention.message,
        form: attention.form,
        options: attention.options,
        ...(attention.other === true ? { other: true } : {}),
        ...(attention.recommendation !== undefined
          ? { recommendation: attention.recommendation }
          : {}),
      };
    case 'awaiting_response':
      return {
        kind: 'awaiting_response',
        ref: runItemRef(run.id, attention.occurrence),
        ...base,
        run: { ...held, node: attention.respondTo.nodeId, occurrence: attention.occurrence },
        message: attention.message,
      };
    case 'usage_limit':
      return {
        kind: 'usage_limit',
        ref: runItemRef(run.id),
        ...base,
        run: { ...held, node: attention.nodeId },
        resetAt: attention.resumeAt,
      };
    case 'unreadable':
      return {
        kind: 'unreadable',
        ref: runItemRef(run.id),
        ...base,
        run: held,
        reason: attention.reason,
        detail: attention.detail,
      };
  }
}

/** What the queue reads: the store, and the host's record of each checkout's branch. */
export interface AttentionQueueSource {
  store: Pick<
    IWorkflowStore,
    | 'listAttentionQueueRows'
    | 'getWorkflowRun'
    | 'getWorkflowRunForAttention'
    | 'getCodebase'
    | 'getItem'
  >;
  /** The branch of a run's checkout; null when the host has no record of one. */
  branchOf(run: WorkflowRun): Promise<string | null>;
  /**
   * The open items no run holds. Nothing stores one yet, so no host sets this; it is
   * where a source of such items joins the one reader.
   */
  itemsWithoutRun?(): Promise<readonly AttentionQueueItemWithoutRun[]>;
}

export type CodebaseCache = Map<string, Promise<AttentionQueueItemSources['codebase']>>;

function codebaseFor(
  source: { store: Pick<IWorkflowStore, 'getCodebase'> },
  run: WorkflowRun,
  codebases: CodebaseCache
): Promise<AttentionQueueItemSources['codebase']> {
  if (run.codebase_id === null) return Promise.resolve(null);
  const cached = codebases.get(run.codebase_id) ?? source.store.getCodebase(run.codebase_id);
  codebases.set(run.codebase_id, cached);
  return cached;
}

/** The project `run` belongs to, by the rule its queue item reports. */
export async function runProject(
  source: { store: Pick<IWorkflowStore, 'getCodebase'> },
  run: WorkflowRun,
  codebases: CodebaseCache = new Map()
): Promise<ProjectRef | null> {
  return projectRefForRun(run, await codebaseFor(source, run, codebases));
}

async function itemFor(
  source: AttentionQueueSource,
  run: WorkflowRun,
  attention: QueuedRunAttention,
  codebases: CodebaseCache
): Promise<RunAttentionQueueItem> {
  return toAttentionQueueItem(run, attention, {
    codebase: await codebaseFor(source, run, codebases),
    branch: await source.branchOf(run),
    // Only a run started for an item has one, so most reads skip the store.
    item: run.item_id === null ? null : await source.store.getItem(run.item_id),
  });
}

/**
 * The attention that makes `run` an item of its own. A parent blocked on sub-runs is one
 * only when the walk the single read uses stops at the parent, because its sub-run tree
 * cannot be read; otherwise the walk reaches a child, which is listed by its own row.
 */
async function ownQueuedAttention(
  source: AttentionQueueSource,
  run: WorkflowRun
): Promise<QueuedRunAttention | undefined> {
  const own = queuedRunAttention(run);
  if (own !== undefined) return own;
  const resolution = await resolveRunAttention(source.store, run);
  return resolution.kind === 'attention' && resolution.attention.runId === run.id
    ? queuedRunAttention(run, resolution.attention)
    : undefined;
}

/**
 * The item `run` is on its own, or null when it is none: not paused, or a parent whose
 * walk reaches a child, which is an item by its own row. The list and the stream use
 * this one rule.
 */
export async function attentionQueueItemForRun(
  source: AttentionQueueSource,
  run: WorkflowRun,
  codebases: CodebaseCache = new Map()
): Promise<RunAttentionQueueItem | null> {
  if (run.status !== 'paused') return null;
  const attention = await ownQueuedAttention(source, run);
  return attention === undefined ? null : itemFor(source, run, attention, codebases);
}

/** The items the store's queue rows hold, in the rows' order. */
async function runAttentionQueueItems(
  source: AttentionQueueSource,
  runs: readonly AttentionRead<WorkflowRun>[]
): Promise<AttentionRead<RunAttentionQueueItem>[]> {
  const unreadableIds = new Set(splitAttentionRead(runs).degraded.map(report => report.runId));
  const reportedUnreadableRun = new Error('Run already reported unreadable by attention batch');
  const unreadableDescendant = new Error('Unreadable attention descendant');
  const batchSource: AttentionQueueSource = {
    ...source,
    store: {
      listAttentionQueueRows: () => source.store.listAttentionQueueRows(),
      getWorkflowRunForAttention: id => source.store.getWorkflowRunForAttention(id),
      getCodebase: id => source.store.getCodebase(id),
      getItem: id => source.store.getItem(id),
      getWorkflowRun: async id => {
        // The batch already reports this row. Rereading it could log stored parser text;
        // treating it as missing would instead invent a missing-child queue item.
        if (unreadableIds.has(id)) throw reportedUnreadableRun;
        const child = await source.store.getWorkflowRunForAttention(id);
        if (child !== null && isAttentionDegraded(child)) throw unreadableDescendant;
        return child;
      },
    },
  };
  const codebases: CodebaseCache = new Map();
  const items: AttentionRead<RunAttentionQueueItem>[] = [];
  for (const run of runs) {
    if (isAttentionDegraded(run)) {
      items.push(run);
      continue;
    }
    try {
      const item = await attentionQueueItemForRun(batchSource, run, codebases);
      if (item !== null) items.push(item);
    } catch (error) {
      if (error === reportedUnreadableRun) continue;
      if (error !== unreadableDescendant) throw error;
      items.push({ type: 'degraded', reason: 'run_unreadable', runId: run.id });
    }
  }
  return items;
}

/**
 * Every open item in the install: the one entry every surface lists through. The items
 * paused runs hold come first, in the store's order (most recently started run first),
 * then the items no run holds. A host that also needs the queue rows passes the ones it
 * read as `runs`, so both come from one read.
 */
export async function listAttentionQueue(
  source: AttentionQueueSource,
  runs?: readonly AttentionRead<WorkflowRun>[]
): Promise<AttentionRead<AttentionQueueItem>[]> {
  return [
    ...(await runAttentionQueueItems(
      source,
      runs ?? (await source.store.listAttentionQueueRows())
    )),
    ...((await source.itemsWithoutRun?.()) ?? []),
  ];
}

/**
 * The item a run stands for, or null when it has no queue item. A parent blocked on
 * sub-runs resolves to the first of them that is an item, by the walk `workflow wait`
 * uses. Undefined when the run does not exist.
 */
export async function readAttentionQueueItem(
  source: AttentionQueueSource,
  runId: string
): Promise<RunAttentionQueueItem | null | undefined> {
  const run = await source.store.getWorkflowRun(runId);
  if (run === null) return undefined;
  const resolution = await resolveRunAttention(source.store, run);
  if (resolution.kind !== 'attention') return null;
  const holder =
    resolution.attention.runId === run.id
      ? run
      : await source.store.getWorkflowRun(resolution.attention.runId);
  const attention = holder === null ? undefined : queuedRunAttention(holder, resolution.attention);
  return holder === null || attention === undefined
    ? null
    : itemFor(source, holder, attention, new Map());
}

/**
 * What an item ref names now: the item it was handed out with (`found`), a different
 * item where that one was (`moved`: the pause it named is over and its run holds another),
 * no open item (`none`), or nothing this install knows (`unknown`).
 */
export type AttentionItemRefRead =
  | { kind: 'found'; item: AttentionQueueItem }
  | { kind: 'moved'; item: AttentionQueueItem }
  | { kind: 'none' }
  | { kind: 'unknown' };

/** Read the item `ref` names: an item no run holds, or else the item of the run it names. */
export async function readAttentionQueueItemByRef(
  source: AttentionQueueSource,
  ref: string
): Promise<AttentionItemRefRead> {
  const withoutRun = (await source.itemsWithoutRun?.())?.find(item => item.ref === ref);
  if (withoutRun !== undefined) return { kind: 'found', item: withoutRun };
  const runId = runIdOfRef(ref);
  if (runId === '') return { kind: 'unknown' };
  const item = await readAttentionQueueItem(source, runId);
  if (item === undefined) return { kind: 'unknown' };
  if (item === null) return { kind: 'none' };
  return { kind: item.ref === ref ? 'found' : 'moved', item };
}

/** Which items a query covers: one project, or the whole install. */
export type AttentionQueueScope = { kind: 'all' } | { kind: 'project'; project: ProjectRef };

/**
 * True when an item's project is in `scope`. Codebase ids decide when both sides have
 * one, so a renamed codebase's older runs, whose frozen storage root keeps the old key,
 * stay in scope. Otherwise keys decide, which is how unregistered projects match.
 */
export function isInAttentionScope(
  project: ProjectRef | null,
  scope: AttentionQueueScope
): boolean {
  if (scope.kind === 'all') return true;
  if (project === null) return false;
  return project.codebaseId !== null && scope.project.codebaseId !== null
    ? project.codebaseId === scope.project.codebaseId
    : project.key === scope.project.key;
}

/** Ordering for a list: oldest pause first, or by one label's value as a plain string. */
export type AttentionQueueOrder = { by: 'age' } | { by: 'label'; key: string };

/** What a count groups by: project, one label's value, or who answered. */
export type AttentionQueueCountBy = {
  [Counts in AttentionQueueCounts as Counts['by']]: Omit<Counts, 'counts'>;
}[AttentionQueueCounts['by']];

export interface AttentionQueueQuery {
  scope: AttentionQueueScope;
  /** Exact label matches; every one must hold. */
  labels: Readonly<AttentionLabels>;
}

const LABEL_PREFIX = 'label:';

function parseLabelSelector(text: string, flag: string): string {
  const key = attentionLabelKeySchema.safeParse(text.slice(LABEL_PREFIX.length));
  if (!key.success) throw new Error(`${flag} '${text}' names an invalid label key`);
  return key.data;
}

/** Parse `--sort`: `age` or `label:<key>`. */
export function parseAttentionQueueOrder(text: string): AttentionQueueOrder {
  if (text === 'age') return { by: 'age' };
  if (text.startsWith(LABEL_PREFIX)) return { by: 'label', key: parseLabelSelector(text, 'sort') };
  throw new Error(`sort must be 'age' or 'label:<key>', got '${text}'`);
}

/** Parse `--count-by`: `project`, `label:<key>` or `answerer`. */
export function parseAttentionQueueCountBy(text: string): AttentionQueueCountBy {
  if (text === 'project') return { by: 'project' };
  if (text === 'answerer') return { by: 'answerer' };
  if (text.startsWith(LABEL_PREFIX))
    return { by: 'label', key: parseLabelSelector(text, 'count-by') };
  throw new Error(`count-by must be 'project', 'label:<key>' or 'answerer', got '${text}'`);
}

/**
 * Parse `k=v` label assignments, for filters and label writes alike. The key ends at the
 * first `=`; the value is the rest, and may be empty. A key given twice is refused.
 */
export function parseAttentionLabelPairs(pairs: readonly string[]): AttentionLabels {
  const labels: AttentionLabels = {};
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    const key = attentionLabelKeySchema.safeParse(separator < 0 ? '' : pair.slice(0, separator));
    if (!key.success) {
      const reason = key.error.issues[0]?.message ?? 'invalid key';
      throw new Error(`Expected a label as key=value, got '${pair}' (${reason})`);
    }
    if (Object.hasOwn(labels, key.data)) throw new Error(`Label '${key.data}' is given twice`);
    labels[key.data] = pair.slice(separator + 1);
  }
  return labels;
}

/** A list or count request as a host receives it, before the host resolves scope. */
export interface AttentionQueueRequestText {
  project?: string;
  all?: boolean;
  labels: readonly string[];
  sort?: string;
  countBy?: string;
  /** Set when the count reads started waits from events, not the items open now. */
  since?: string;
}

/**
 * Parse a list or count request, refusing contradictory parameters. Scope stays with the
 * host: a CLI defaults to its working directory's project, a server to the whole install.
 */
export function parseAttentionQueueRequest(request: AttentionQueueRequestText): {
  labels: AttentionLabels;
  order: AttentionQueueOrder;
  countBy: AttentionQueueCountBy | undefined;
} {
  if (request.project !== undefined && request.all === true)
    throw new Error('Use project or all, not both');
  if (request.sort !== undefined && request.countBy !== undefined)
    throw new Error('Use sort or count-by, not both');
  // An open item has no answer yet, so only a count of started waits can group by it.
  if (request.countBy === 'answerer' && request.since === undefined)
    throw new Error("count-by 'answerer' counts answered waits from events and needs since");
  return {
    labels: parseAttentionLabelPairs(request.labels),
    order: parseAttentionQueueOrder(request.sort ?? 'age'),
    countBy:
      request.countBy === undefined ? undefined : parseAttentionQueueCountBy(request.countBy),
  };
}

/** True when the item carries every one of `labels`, each with exactly that value. */
export function matchesAttentionLabels(
  item: Pick<AttentionQueueItem, 'labels'>,
  labels: Readonly<AttentionLabels>
): boolean {
  return Object.entries(labels).every(
    ([key, value]) => Object.hasOwn(item.labels, key) && item.labels[key] === value
  );
}

/** True when an item's project is in the query's scope and it carries the query's labels. */
export function inAttentionQuery(
  item: Pick<AttentionQueueItem, 'project' | 'labels'>,
  query: AttentionQueueQuery
): boolean {
  return (
    isInAttentionScope(item.project, query.scope) && matchesAttentionLabels(item, query.labels)
  );
}

export function compareAttentionStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Oldest pause first; a pause that records no time after every timed one. */
function compareAge(a: AttentionQueueItem, b: AttentionQueueItem): number {
  if (a.pausedAt !== b.pausedAt) {
    if (a.pausedAt === null) return 1;
    if (b.pausedAt === null) return -1;
    return Date.parse(a.pausedAt) - Date.parse(b.pausedAt);
  }
  return compareAttentionStrings(a.ref, b.ref);
}

/** The items `query` selects, in `order`. Items without the sort label come last. */
export function selectAttentionQueue(
  items: readonly AttentionQueueItem[],
  query: AttentionQueueQuery & { order: AttentionQueueOrder }
): AttentionQueueItem[] {
  const selected = items.filter(item => inAttentionQuery(item, query));
  const { order } = query;
  if (order.by === 'age') return selected.sort(compareAge);
  const labelOf = (item: AttentionQueueItem): string | undefined =>
    Object.hasOwn(item.labels, order.key) ? item.labels[order.key] : undefined;
  return selected.sort((a, b) => {
    const [x, y] = [labelOf(a), labelOf(b)];
    if (x !== y) {
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      return compareAttentionStrings(x, y);
    }
    return compareAge(a, b);
  });
}
