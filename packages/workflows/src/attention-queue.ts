/**
 * The attention queue: every paused run that needs someone, as a typed item an answerer
 * outside Archon can list, filter, count and read without parsing prose (#4039).
 *
 * `toAttentionQueueItem` is the one constructor: it builds an item from a run row and its
 * run-attention projection, so the list, the single read and the stream
 * (`attention-watch.ts`) cannot disagree. Labels are data. The queue filters them by exact match and sorts them as
 * plain strings, and nothing here depends on who is asking.
 */
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
  type QueuedRunAttention,
  type WorkflowRun,
} from './schemas/workflow-run';
import { resolveRunAttention } from './run-attention-resolution';
import { stateProjectKeySchema } from './state-document-store';
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

/** What an item's run is part of; attention stream lines carry the same two fields. */
export const attentionItemRunContextFields = {
  workflow: z.string(),
  /** The run's direct parent run, for every child run; null for a top-level run. */
  parentRunId: z.string().nullable(),
};

const itemBase = {
  runId: z.string(),
  workflow: attentionItemRunContextFields.workflow,
  /** Null only when the run has no trusted storage root, so there is no key to give. */
  project: projectRefSchema.nullable(),
  parentRunId: attentionItemRunContextFields.parentRunId,
  /** Set when the run is a `fan_out:` child; null for every other run. */
  fanOut: fanOutPositionSchema.nullable(),
  /** 1, plus one for every label write since the pause opened. */
  revision: z.number().int().positive(),
  labels: attentionLabelsSchema,
  /** When the pause opened; null when the pause records no time (gates). */
  pausedAt: z.string().datetime().nullable(),
  context: attentionQueueContextSchema,
};

/**
 * One queue item. `kind` is the run-attention kind it was built from: `attention` is a
 * `wait: attention` pause, answered with `answer`; `awaiting_response` is a gate,
 * answered with `approve`, `reject` or `respond`; `usage_limit` is a run waiting for a
 * provider usage limit, or a rate limit that outlasted its retries, that tries again by
 * itself at `resetAt` (the provider's reported reset, or a computed backoff for a rate
 * limit) and needs no answer; `unreadable` is a paused run nothing can describe, which someone has to look at
 * and resume or abandon.
 */
export const attentionQueueItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('attention'),
    ...itemBase,
    node: z.string(),
    occurrence: z.string(),
    message: z.string(),
    form: attentionFormSchema,
    options: z.array(attentionOptionSchema),
  }),
  z.object({
    kind: z.literal('awaiting_response'),
    ...itemBase,
    node: z.string(),
    occurrence: z.string(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal('usage_limit'),
    ...itemBase,
    node: z.string(),
    resetAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal('unreadable'),
    ...itemBase,
    reason: runAttentionUnreadableReasonSchema,
    detail: z.string(),
  }),
]);
export type AttentionQueueItem = z.infer<typeof attentionQueueItemSchema>;

/** The run facts an item needs beyond the row, read by the host. */
export interface AttentionQueueItemSources {
  /** The run's codebase row; null when it has none. */
  codebase: { id: string; kind?: string | null; name: string; default_cwd: string } | null;
  /** The branch of the run's checkout, from the host's isolation records. */
  branch: string | null;
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

/** Build the queue item for `run`, whose run-attention is `attention`. */
export function toAttentionQueueItem(
  run: WorkflowRun,
  attention: QueuedRunAttention,
  sources: AttentionQueueItemSources
): AttentionQueueItem {
  const root = resolveRunStorageRoot(run, sources.codebase);
  const wait = attention.kind === 'attention' ? pausedAttentionWait(run) : undefined;
  const base = {
    runId: run.id,
    workflow: run.workflow_name,
    project: projectRefForRun(run, sources.codebase),
    parentRunId: run.parent_run_id,
    fanOut: fanOutPosition(run),
    revision: wait === undefined ? 1 : attentionRevision(wait),
    labels: wait === undefined ? {} : attentionLabels(wait),
    pausedAt: (wait ?? pausedUsageLimitWait(run))?.waitingSince ?? null,
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
        ...base,
        node: attention.nodeId,
        occurrence: attention.occurrence,
        message: attention.message,
        form: attention.form,
        options: attention.options,
      };
    case 'awaiting_response':
      return {
        kind: 'awaiting_response',
        ...base,
        node: attention.respondTo.nodeId,
        occurrence: attention.occurrence,
        message: attention.message,
      };
    case 'usage_limit':
      return { kind: 'usage_limit', ...base, node: attention.nodeId, resetAt: attention.resumeAt };
    case 'unreadable':
      return { kind: 'unreadable', ...base, reason: attention.reason, detail: attention.detail };
  }
}

/** What the queue reads: the store, and the host's record of each checkout's branch. */
export interface AttentionQueueSource {
  store: Pick<IWorkflowStore, 'listAttentionQueueRows' | 'getWorkflowRun' | 'getCodebase'>;
  /** The branch of a run's checkout; null when the host has no record of one. */
  branchOf(run: WorkflowRun): Promise<string | null>;
}

type CodebaseCache = Map<string, Promise<AttentionQueueItemSources['codebase']>>;

function codebaseFor(
  source: Pick<AttentionQueueSource, 'store'>,
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
  source: Pick<AttentionQueueSource, 'store'>,
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
): Promise<AttentionQueueItem> {
  return toAttentionQueueItem(run, attention, {
    codebase: await codebaseFor(source, run, codebases),
    branch: await source.branchOf(run),
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
): Promise<AttentionQueueItem | null> {
  if (run.status !== 'paused') return null;
  const attention = await ownQueuedAttention(source, run);
  return attention === undefined ? null : itemFor(source, run, attention, codebases);
}

/** The items for rows the store's queue list returned, in their order. */
export async function attentionQueueItems(
  source: AttentionQueueSource,
  runs: readonly WorkflowRun[]
): Promise<AttentionQueueItem[]> {
  const codebases: CodebaseCache = new Map();
  const items: AttentionQueueItem[] = [];
  for (const run of runs) {
    const item = await attentionQueueItemForRun(source, run, codebases);
    if (item !== null) items.push(item);
  }
  return items;
}

/** Every item in the install, in the store's order: most recently started run first. */
export async function listAttentionQueue(
  source: AttentionQueueSource
): Promise<AttentionQueueItem[]> {
  return attentionQueueItems(source, await source.store.listAttentionQueueRows());
}

/**
 * The item a run stands for, or null when it has no queue item. A parent blocked on
 * sub-runs resolves to the first of them that is an item, by the walk `workflow wait`
 * uses. Undefined when the run does not exist.
 */
export async function readAttentionQueueItem(
  source: AttentionQueueSource,
  runId: string
): Promise<AttentionQueueItem | null | undefined> {
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

/** What a count groups by: project, or one label's value. */
export type AttentionQueueCountBy = { by: 'project' } | { by: 'label'; key: string };

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

/** Parse `--count-by`: `project` or `label:<key>`. */
export function parseAttentionQueueCountBy(text: string): AttentionQueueCountBy {
  if (text === 'project') return { by: 'project' };
  if (text.startsWith(LABEL_PREFIX))
    return { by: 'label', key: parseLabelSelector(text, 'count-by') };
  throw new Error(`count-by must be 'project' or 'label:<key>', got '${text}'`);
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

function inQuery(item: AttentionQueueItem, query: AttentionQueueQuery): boolean {
  return (
    isInAttentionScope(item.project, query.scope) && matchesAttentionLabels(item, query.labels)
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Oldest pause first; a pause that records no time after every timed one. */
function compareAge(a: AttentionQueueItem, b: AttentionQueueItem): number {
  if (a.pausedAt !== b.pausedAt) {
    if (a.pausedAt === null) return 1;
    if (b.pausedAt === null) return -1;
    return Date.parse(a.pausedAt) - Date.parse(b.pausedAt);
  }
  return compareStrings(a.runId, b.runId);
}

/** The items `query` selects, in `order`. Items without the sort label come last. */
export function selectAttentionQueue(
  items: readonly AttentionQueueItem[],
  query: AttentionQueueQuery & { order: AttentionQueueOrder }
): AttentionQueueItem[] {
  const selected = items.filter(item => inQuery(item, query));
  const { order } = query;
  if (order.by === 'age') return selected.sort(compareAge);
  const labelOf = (item: AttentionQueueItem): string | undefined =>
    Object.hasOwn(item.labels, order.key) ? item.labels[order.key] : undefined;
  return selected.sort((a, b) => {
    const [x, y] = [labelOf(a), labelOf(b)];
    if (x !== y) {
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      return compareStrings(x, y);
    }
    return compareAge(a, b);
  });
}

export const attentionQueueCountsSchema = z.discriminatedUnion('by', [
  z.object({
    by: z.literal('project'),
    counts: z.array(z.object({ project: projectRefSchema.nullable(), count: z.number().int() })),
  }),
  z.object({
    by: z.literal('label'),
    key: z.string(),
    /** `value` is null for the items that have no such label. */
    counts: z.array(z.object({ value: z.string().nullable(), count: z.number().int() })),
  }),
]);
export type AttentionQueueCounts = z.infer<typeof attentionQueueCountsSchema>;

/**
 * How many items `query` selects under each project, or each value of one label, most
 * first. Projects group by the scope rule: a codebase id when the item has one, else
 * its key. A group shows the project of its first item in `items`' order.
 */
export function countAttentionQueue(
  items: readonly AttentionQueueItem[],
  query: AttentionQueueQuery & { countBy: AttentionQueueCountBy }
): AttentionQueueCounts {
  const selected = items.filter(item => inQuery(item, query));
  const { countBy } = query;
  if (countBy.by === 'project') {
    const groups = new Map<string, { project: ProjectRef | null; count: number }>();
    for (const item of selected) {
      const id =
        item.project === null
          ? 'none'
          : item.project.codebaseId !== null
            ? `codebase:${item.project.codebaseId}`
            : `key:${item.project.key}`;
      const group = groups.get(id) ?? { project: item.project, count: 0 };
      group.count += 1;
      groups.set(id, group);
    }
    return {
      by: 'project',
      counts: [...groups.values()].sort(
        (a, b) => b.count - a.count || compareStrings(a.project?.key ?? '', b.project?.key ?? '')
      ),
    };
  }
  const groups = new Map<string | null, number>();
  for (const item of selected) {
    const value = Object.hasOwn(item.labels, countBy.key) ? (item.labels[countBy.key] ?? '') : null;
    groups.set(value, (groups.get(value) ?? 0) + 1);
  }
  return {
    by: 'label',
    key: countBy.key,
    counts: [...groups.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || compareStrings(a.value ?? '', b.value ?? '')),
  };
}
