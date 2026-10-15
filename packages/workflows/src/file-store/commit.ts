import { randomUUID } from 'node:crypto';
import {
  WorkflowEventCursorError,
  type WorkflowEventCursor,
  type WorkflowEventPage,
  type IWorkflowEventFeed,
} from '../store';
import { mkdir, open, readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { createLogger } from '@archon/paths';
import { workflowRunSchema, type WorkflowRun } from '../schemas/workflow-run';
import { workflowEventRowSchema, type WorkflowEventRow } from '../schemas/workflow-event';
import {
  probeFileStoreFilesystem,
  renameReplacing,
  withFileStoreLock,
  retryFileStoreHandles,
} from './lock';

const log = createLogger('file-store');
export const persistedRunSchema = workflowRunSchema.extend({
  started_at: z.coerce.date(),
  last_activity_at: z.coerce.date().nullable(),
  completed_at: z.coerce.date().nullable(),
});
const lineSchema = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  run: persistedRunSchema,
  events: z.array(workflowEventRowSchema),
  retract: z.array(z.string()),
});
export type RunCommitLine = z.infer<typeof lineSchema>;
const headSchema = z.object({ format: z.literal(1), seq: z.number().int().nonnegative() });
const intentSchema = z.object({
  seq: z.number().int().positive(),
  lines: z.array(lineSchema),
  documents: z.record(z.string(), z.unknown()),
  deleteRuns: z.array(z.string()),
  immutableDocuments: z.record(z.string(), z.unknown()).default({}),
  deleteDocuments: z.array(z.string()).default([]),
});
type Intent = z.infer<typeof intentSchema>;
const feedIndexSchema = headSchema.extend({
  runs: z.record(z.string(), z.number().int().positive()),
});
type FeedIndex = z.infer<typeof feedIndexSchema>;

// Cleanup transfers logs to the feed archive; the index remains disposable.
async function rebuildFeedIndex(root: string, seq: number): Promise<FeedIndex> {
  const runs: FeedIndex['runs'] = {};
  await mkdir(archiveRoot(root), { recursive: true });
  const dirs = [
    ...(await readdir(join(root, 'runs'), { withFileTypes: true })),
    ...(await readdir(archiveRoot(root), { withFileTypes: true })),
  ];
  for (let start = 0; start < dirs.length; start += 64) {
    await Promise.all(
      dirs
        .slice(start, start + 64)
        .filter(dir => dir.isDirectory())
        .map(async dir => {
          const last = (await readFeedLog(root, dir.name)).lines
            .reverse()
            .find(line => line.events.length > 0);
          if (last) runs[dir.name] = last.seq;
        })
    );
  }
  const index = { format: 1 as const, seq, runs };
  await replaceJson(join(root, 'feed-index.json'), index);
  return index;
}
async function readFeedIndex(root: string, seq: number): Promise<FeedIndex> {
  const value = await readJson(join(root, 'feed-index.json'));
  const index = value === undefined ? undefined : feedIndexSchema.parse(value);
  return index?.seq === seq ? index : rebuildFeedIndex(root, seq);
}
async function updateFeedIndex(root: string, intent: Intent): Promise<void> {
  const value = await readJson(join(root, 'feed-index.json'));
  const index = value === undefined ? undefined : feedIndexSchema.parse(value);
  if (index?.seq === intent.seq) return;
  if (index?.seq !== (await readHead(root))) {
    await rebuildFeedIndex(root, intent.seq);
    return;
  }
  for (const line of intent.lines) if (line.events.length) index.runs[line.run.id] = line.seq;
  index.seq = intent.seq;
  await replaceJson(join(root, 'feed-index.json'), index);
}
export interface CommitChanges {
  runs?: { run: WorkflowRun; events?: WorkflowEventRow[]; retract?: string[] }[];
  documents?: Record<string, unknown>;
  deleteRuns?: string[];
  immutableDocuments?: Intent['immutableDocuments'];
  deleteDocuments?: Intent['deleteDocuments'];
}
export interface RunState {
  run: WorkflowRun;
  events: WorkflowEventRow[];
}

export function runPath(root: string, id: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error(`Invalid file store run id: ${id}`);
  return join(root, 'runs', id);
}
// Deletion moves a run's log here; the ID stays reserved so the feed never loses its history.
function archiveRoot(root: string): string {
  return join(root, 'archived-runs');
}
function archivedRunPath(root: string, id: string): string {
  runPath(root, id);
  return join(archiveRoot(root), id);
}
/** Whether `id` belonged to a deleted run. Callers creating a run must hold the store lock. */
export async function isRunArchived(root: string, id: string): Promise<boolean> {
  try {
    await stat(archivedRunPath(root, id));
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
function documentPath(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Invalid store document path');
  return target;
}
export async function readJson(path: string): Promise<unknown> {
  try {
    const { value } = await retryFileStoreHandles('read', path, () => readFile(path, 'utf8'));
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
async function syncDirectory(path: string): Promise<void> {
  // Windows does not support opening a directory for fsync through node:fs.
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function replaceJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const contents = JSON.stringify(value);
  const scratch = `${path}.${randomUUID()}.tmp`;
  const file = await open(scratch, 'wx', 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
  await renameReplacing(scratch, path);
  await syncDirectory(dirname(path));
}
async function removeDocument(path: string): Promise<void> {
  try {
    await retryFileStoreHandles('unlink', path, () => unlink(path));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}
async function publishJson(path: string, value: unknown): Promise<void> {
  const contents = JSON.stringify(value);
  const scratch = `${path}.publish.tmp`;
  let existing: string | undefined;
  try {
    existing = (await retryFileStoreHandles('read', path, () => readFile(path, 'utf8'))).value;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (existing !== undefined) {
    if (existing !== contents) throw new Error(`Immutable store document differs: ${path}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await removeDocument(scratch);
    const file = await open(scratch, 'wx', 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    // The store lock keeps the checked destination absent until publication.
    await renameReplacing(scratch, path);
  }
  if (existing !== undefined) await removeDocument(scratch);
  await syncDirectory(dirname(path));
}
async function readLog(
  root: string,
  id: string,
  archived = false
): Promise<{ lines: RunCommitLine[]; bytes: number; total: number }> {
  let contents: Buffer;
  try {
    const path = join(archived ? archivedRunPath(root, id) : runPath(root, id), 'log.jsonl');
    contents = (await retryFileStoreHandles('read', path, () => readFile(path))).value;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { lines: [], bytes: 0, total: 0 };
    throw error;
  }
  const bytes = contents.lastIndexOf(10) + 1;
  const text = contents.subarray(0, bytes).toString('utf8');
  return {
    lines: text
      .split('\n')
      .filter(Boolean)
      .map(line => lineSchema.parse(JSON.parse(line))),
    bytes,
    total: contents.length,
  };
}
async function readFeedLog(root: string, id: string): ReturnType<typeof readLog> {
  const live = await readLog(root, id);
  return live.lines.length ? live : readLog(root, id, true);
}
async function archiveRunLog(root: string, id: string): Promise<void> {
  const source = runPath(root, id);
  const target = archivedRunPath(root, id);
  await mkdir(target, { recursive: true });
  await syncDirectory(root);
  await syncDirectory(dirname(target));
  try {
    await renameReplacing(join(source, 'log.jsonl'), join(target, 'log.jsonl'));
  } catch (error) {
    // Redo may find the log already transferred and the run directory removed.
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    if (!(await readLog(root, id, true)).lines.length)
      throw new Error('Deleted run has no retained feed log', { cause: error });
    await syncDirectory(target);
    return;
  }
  await syncDirectory(target);
  await syncDirectory(source);
}
async function lastLogLine(root: string, id: string): Promise<RunCommitLine | null> {
  return (
    await retryFileStoreHandles('read', join(runPath(root, id), 'log.jsonl'), () =>
      readLastLogLine(root, id)
    )
  ).value;
}
async function readLastLogLine(root: string, id: string): Promise<RunCommitLine | null> {
  let file;
  try {
    file = await open(join(runPath(root, id), 'log.jsonl'), 'r');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const { size } = await file.stat();
    for (let length = Math.min(size, 4096); length > 0; length = Math.min(size, length * 2)) {
      const bytes = Buffer.alloc(length);
      await file.read(bytes, 0, length, size - length);
      const end = bytes.lastIndexOf(10);
      const start = end < 0 ? -1 : bytes.lastIndexOf(10, end - 1);
      if (end >= 0 && (start >= 0 || length === size))
        return lineSchema.parse(JSON.parse(bytes.subarray(start + 1, end).toString('utf8')));
      if (length === size) return null;
    }
    return null;
  } finally {
    await file.close();
  }
}
export async function readRunState(root: string, id: string): Promise<RunState | null> {
  const { lines } = await readLog(root, id);
  const last = lines.at(-1);
  if (!last) return null;
  const retracted = new Set(lines.flatMap(line => line.retract));
  return {
    run: last.run,
    events: lines.flatMap(line => line.events).filter(event => !retracted.has(event.id)),
  };
}
async function apply(root: string, intent: Intent): Promise<void> {
  for (const line of intent.lines) {
    const dir = runPath(root, line.run.id);
    await mkdir(dir, { recursive: true });
    await syncDirectory(dirname(dir));
    const last = await lastLogLine(root, line.run.id);
    if (last && last.seq > line.seq) throw new Error('File store intent is behind the log');
    // Tail repair uses a read/write handle: Windows cannot truncate an append-only handle.
    await truncateTornTail(join(dir, 'log.jsonl'));
    const file = await open(join(dir, 'log.jsonl'), 'a+', 0o600);
    try {
      if (last?.seq !== line.seq) await file.writeFile(`${JSON.stringify(line)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await replaceJson(join(dir, 'run.json'), { seq: line.seq, run: line.run });
    await syncDirectory(dir);
  }
  for (const [path, value] of Object.entries(intent.documents))
    await replaceJson(documentPath(root, path), value);
  for (const [path, value] of Object.entries(intent.immutableDocuments))
    await publishJson(documentPath(root, path), value);
  for (const path of intent.deleteDocuments) {
    const target = documentPath(root, path);
    await removeDocument(target);
    await syncDirectory(dirname(target));
  }
  if (Object.keys(intent.immutableDocuments).length) {
    for (const path of Object.keys(intent.immutableDocuments))
      await syncDirectory(dirname(dirname(documentPath(root, path))));
    await syncDirectory(root);
  }
  for (const id of intent.deleteRuns) {
    await archiveRunLog(root, id);
    await retryFileStoreHandles('remove', runPath(root, id), () =>
      rm(runPath(root, id), { recursive: true, force: true })
    );
  }
  if (intent.deleteRuns.length) await syncDirectory(join(root, 'runs'));
  await updateFeedIndex(root, intent);
  await replaceJson(join(root, 'head.json'), { format: 1, seq: intent.seq });
  await retryFileStoreHandles('unlink', join(root, 'intent.json'), () =>
    unlink(join(root, 'intent.json'))
  );
  await syncDirectory(root);
}
async function redo(root: string): Promise<void> {
  const pending = await readJson(join(root, 'intent.json'));
  if (pending === undefined) return;
  const intent = intentSchema.parse(pending);
  await apply(root, intent);
  log.info({ seq: intent.seq }, 'file_store.intent_redone');
}
export async function openFileStore(root: string): Promise<void> {
  await probeFileStoreFilesystem(root);
  await withFileStoreLock(root, async () => {
    const head = await readJson(join(root, 'head.json'));
    if (head !== undefined) headSchema.parse(head);
    await redo(root);
    if (head === undefined && (await readJson(join(root, 'head.json'))) === undefined)
      await replaceJson(join(root, 'head.json'), { format: 1, seq: 0 });
    await mkdir(join(root, 'runs'), { recursive: true });
    await readFeedIndex(root, await readHead(root));
    await syncDirectory(root);
  });
}
export async function recoverBeforeRead(root: string): Promise<void> {
  if ((await readJson(join(root, 'intent.json'))) !== undefined)
    await withFileStoreLock(root, () => redo(root));
}
/** The snapshot's run when it matches the last log line; undefined when missing or stale. */
async function freshSnapshot(root: string, id: string): Promise<WorkflowRun | undefined> {
  const snapshot = await readJson(join(runPath(root, id), 'run.json'));
  if (snapshot === undefined) return undefined;
  const parsed = z.object({ seq: z.number(), run: persistedRunSchema }).parse(snapshot);
  const last = await lastLogLine(root, id);
  if (last?.seq === parsed.seq) return parsed.run;
  if (last && last.seq < parsed.seq)
    throw new Error('File store snapshot is ahead of the committed log');
  return undefined;
}
async function listWith(
  root: string,
  read: (id: string) => Promise<WorkflowRun | null>
): Promise<WorkflowRun[]> {
  const dirs = await readdir(join(root, 'runs'), { withFileTypes: true });
  const result: WorkflowRun[] = [];
  // Bound open handles for large installations, including Windows.
  for (let i = 0; i < dirs.length; i += 64) {
    const rows = await Promise.all(
      dirs
        .slice(i, i + 64)
        .filter(dir => dir.isDirectory())
        .map(dir => read(dir.name))
    );
    for (const row of rows) if (row) result.push(row);
  }
  return result;
}
export async function readRun(root: string, id: string): Promise<WorkflowRun | null> {
  await recoverBeforeRead(root);
  const fresh = await freshSnapshot(root, id);
  if (fresh) return fresh;
  return withFileStoreLock(root, async () => {
    await redo(root);
    const state = await readRunState(root, id);
    const last = (await readLog(root, id)).lines.at(-1);
    if (last)
      await replaceJson(join(runPath(root, id), 'run.json'), { seq: last.seq, run: last.run });
    return state?.run ?? null;
  });
}
export async function listRuns(root: string): Promise<WorkflowRun[]> {
  await recoverBeforeRead(root);
  return listWith(root, id => readRun(root, id));
}
export async function commit<T>(
  root: string,
  runIds: readonly string[] | 'all',
  decide: (runs: Map<string, WorkflowRun>) => Promise<{ result: T; changes: CommitChanges }>
): Promise<T> {
  return withFileStoreLock(root, async () => {
    await redo(root);
    const rows =
      runIds === 'all'
        ? await listRunSnapshots(root)
        : await Promise.all(runIds.map(id => readSnapshot(root, id)));
    const runs = new Map(rows.flatMap(run => (run ? [[run.id, run] as const] : [])));
    const { result, changes } = await decide(runs);
    if (
      !changes.runs?.length &&
      !Object.keys(changes.documents ?? {}).length &&
      !changes.deleteRuns?.length &&
      !Object.keys(changes.immutableDocuments ?? {}).length &&
      !changes.deleteDocuments?.length
    )
      return result;
    const head = headSchema.parse(await readJson(join(root, 'head.json')));
    const seq = head.seq + 1;
    const intent = intentSchema.parse({
      seq,
      lines: (changes.runs ?? []).map(change => ({
        seq,
        at: new Date().toISOString(),
        run: change.run,
        events: change.events ?? [],
        retract: change.retract ?? [],
      })),
      documents: changes.documents ?? {},
      deleteRuns: changes.deleteRuns ?? [],
      immutableDocuments: changes.immutableDocuments ?? {},
      deleteDocuments: changes.deleteDocuments ?? [],
    });
    for (const line of intent.lines) runPath(root, line.run.id);
    for (const path of Object.keys(intent.documents)) documentPath(root, path);
    for (const path of [...Object.keys(intent.immutableDocuments), ...intent.deleteDocuments])
      documentPath(root, path);
    for (const id of intent.deleteRuns) runPath(root, id);
    await replaceJson(join(root, 'intent.json'), intent);
    await apply(root, intent);
    return result;
  });
}

/** Every run's last committed row. The caller holds the lock, as for `readSnapshot`. */
export function listRunSnapshots(root: string): Promise<WorkflowRun[]> {
  return listWith(root, id => readSnapshot(root, id));
}

// The caller holds the lock. The last committed row suffices; never fold event history here.
export async function readSnapshot(root: string, id: string): Promise<WorkflowRun | null> {
  return (await freshSnapshot(root, id)) ?? (await lastLogLine(root, id))?.run ?? null;
}

async function truncateTornTail(path: string): Promise<void> {
  let file;
  try {
    file = await open(path, 'r+');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  try {
    const { size } = await file.stat();
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - 4096);
      const bytes = Buffer.alloc(end - start);
      await file.read(bytes, 0, bytes.length, start);
      const newline = bytes.lastIndexOf(10);
      if (newline >= 0) {
        if (start + newline + 1 !== size) await file.truncate(start + newline + 1);
        return;
      }
      end = start;
    }
    if (size) await file.truncate(0);
  } finally {
    await file.close();
  }
}

const endOfCommit = Number.MAX_SAFE_INTEGER;
function fileCursor(seq: number, index: number): WorkflowEventCursor {
  return `file:${seq}.${index}` as WorkflowEventCursor;
}
function filePosition(cursor: WorkflowEventCursor): { seq: number; index: number } {
  const match = /^file:(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(cursor);
  if (!match) throw new WorkflowEventCursorError();
  const seq = Number(match[1]),
    index = Number(match[2]);
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(index))
    throw new WorkflowEventCursorError();
  return { seq, index };
}
async function readHead(root: string): Promise<number> {
  return headSchema.parse(await readJson(join(root, 'head.json'))).seq;
}
export function createFileEventFeed(root: string): IWorkflowEventFeed {
  return {
    getWorkflowEventHead: async (): Promise<WorkflowEventCursor> => {
      await recoverBeforeRead(root);
      return fileCursor(await readHead(root), endOfCommit);
    },
    readWorkflowEventsAfter: async (after, { limit, eventTypes }): Promise<WorkflowEventPage> => {
      const position = filePosition(after);
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new RangeError('limit must be a positive integer');
      await recoverBeforeRead(root);
      const head = await readHead(root);
      if (position.seq > head) throw new WorkflowEventCursorError();
      if (position.seq === head && position.index === endOfCommit)
        return { events: [], next: after };
      // A committed head must never outrun the log scan: writes/deletes and recovery
      // share this lock. Otherwise a paged scan could advance past an unseen commit.
      return withFileStoreLock(root, async () => {
        await redo(root);
        const head = await readHead(root);
        const deliveries: { seq: number; index: number; event: WorkflowEventRow }[] = [];
        const feedIndex = await readFeedIndex(root, head);
        const ids = Object.entries(feedIndex.runs)
          .filter(
            ([, seq]) =>
              seq > position.seq || (seq === position.seq && position.index !== endOfCommit)
          )
          .map(([id]) => id);
        for (let start = 0; start < ids.length; start += 64) {
          await Promise.all(
            ids.slice(start, start + 64).map(async id => {
              for (const line of (await readFeedLog(root, id)).lines) {
                if (line.seq < position.seq || line.seq > head) continue;
                for (const event of line.events) {
                  const index = event.event_order;
                  if (index == null) throw new Error('File event has no commit position');
                  if (line.seq > position.seq || index > position.index)
                    deliveries.push({ seq: line.seq, index, event });
                }
              }
            })
          );
        }
        deliveries.sort((a, b) => a.seq - b.seq || a.index - b.index);
        const scanned = deliveries.slice(0, limit);
        const last = scanned.at(-1);
        return {
          events: scanned
            .filter(
              ({ event }) =>
                eventTypes === undefined || eventTypes.some(type => type === event.event_type)
            )
            .map(({ seq, index, event }) => ({ cursor: fileCursor(seq, index), event })),
          next:
            deliveries.length <= limit
              ? fileCursor(head, endOfCommit)
              : last
                ? fileCursor(last.seq, last.index)
                : after,
        };
      });
    },
  };
}
