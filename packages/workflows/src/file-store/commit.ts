import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, unlink } from 'node:fs/promises';
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
});
type Intent = z.infer<typeof intentSchema>;
export interface CommitChanges {
  runs?: { run: WorkflowRun; events?: WorkflowEventRow[]; retract?: string[] }[];
  documents?: Record<string, unknown>;
  deleteRuns?: string[];
}
export interface RunState {
  run: WorkflowRun;
  events: WorkflowEventRow[];
}

export function runPath(root: string, id: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error(`Invalid file store run id: ${id}`);
  return join(root, 'runs', id);
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
async function readLog(
  root: string,
  id: string
): Promise<{ lines: RunCommitLine[]; bytes: number; total: number }> {
  let contents: Buffer;
  try {
    const path = join(runPath(root, id), 'log.jsonl');
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
    const prior = await readLog(root, line.run.id);
    const last = prior.lines.at(-1);
    if (last && last.seq > line.seq) throw new Error('File store intent is behind the log');
    const file = await open(join(dir, 'log.jsonl'), 'a+', 0o600);
    try {
      if (prior.bytes !== prior.total) await file.truncate(prior.bytes);
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
  for (const id of intent.deleteRuns)
    await retryFileStoreHandles('remove', runPath(root, id), () =>
      rm(runPath(root, id), { recursive: true, force: true })
    );
  if (intent.deleteRuns.length) await syncDirectory(join(root, 'runs'));
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
    await syncDirectory(root);
  });
}
export async function recoverBeforeRead(root: string): Promise<void> {
  if ((await readJson(join(root, 'intent.json'))) !== undefined)
    await withFileStoreLock(root, () => redo(root));
}
export async function readRun(root: string, id: string): Promise<WorkflowRun | null> {
  await recoverBeforeRead(root);
  const snapshot = await readJson(join(runPath(root, id), 'run.json'));
  if (snapshot !== undefined) {
    const parsed = z.object({ seq: z.number(), run: persistedRunSchema }).parse(snapshot);
    const last = await lastLogLine(root, id);
    if (last?.seq === parsed.seq) return parsed.run;
    if (last && last.seq < parsed.seq)
      throw new Error('File store snapshot is ahead of the committed log');
  }
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
  const dirs = await readdir(join(root, 'runs'), { withFileTypes: true });
  const result: WorkflowRun[] = [];
  // Bound open handles for large installations, including Windows.
  for (let i = 0; i < dirs.length; i += 64) {
    const rows = await Promise.all(
      dirs
        .slice(i, i + 64)
        .filter(dir => dir.isDirectory())
        .map(dir => readRun(root, dir.name))
    );
    for (const row of rows) if (row) result.push(row);
  }
  return result;
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
        ? await listSnapshots(root)
        : await Promise.all(runIds.map(id => readSnapshot(root, id)));
    const runs = new Map(rows.flatMap(run => (run ? [[run.id, run] as const] : [])));
    const { result, changes } = await decide(runs);
    if (
      !changes.runs?.length &&
      !Object.keys(changes.documents ?? {}).length &&
      !changes.deleteRuns?.length
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
    });
    for (const line of intent.lines) runPath(root, line.run.id);
    for (const path of Object.keys(intent.documents)) documentPath(root, path);
    for (const id of intent.deleteRuns) runPath(root, id);
    await replaceJson(join(root, 'intent.json'), intent);
    await apply(root, intent);
    return result;
  });
}

async function readSnapshot(root: string, id: string): Promise<WorkflowRun | null> {
  const snapshot = await readJson(join(runPath(root, id), 'run.json'));
  if (snapshot !== undefined) {
    const parsed = z.object({ seq: z.number(), run: persistedRunSchema }).parse(snapshot);
    const last = await lastLogLine(root, id);
    if (last?.seq === parsed.seq) return parsed.run;
    if (last && last.seq < parsed.seq)
      throw new Error('File store snapshot is ahead of the committed log');
  }
  return (await readRunState(root, id))?.run ?? null;
}
async function listSnapshots(root: string): Promise<WorkflowRun[]> {
  const dirs = await readdir(join(root, 'runs'), { withFileTypes: true });
  const result: WorkflowRun[] = [];
  for (let i = 0; i < dirs.length; i += 64) {
    const rows = await Promise.all(
      dirs
        .slice(i, i + 64)
        .filter(dir => dir.isDirectory())
        .map(dir => readSnapshot(root, dir.name))
    );
    for (const row of rows) if (row) result.push(row);
  }
  return result;
}
