import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  receiptSchema,
  requestSchema,
  bindingSchema,
  pathFor,
  type Receipt,
} from './admission-documents';
import { documentPaths } from './admission-transaction';
import { readJson, replaceJson, syncDirectory } from './commit';

const sequenceSchema = requestSchema.shape.position.safe();
const noticePositionItems = [sequenceSchema, requestSchema.shape.id] as const;
export const admissionPositionSchema = z.tuple([sequenceSchema, requestSchema.shape.id.nullable()]);
export type AdmissionPosition = z.infer<typeof admissionPositionSchema>;
const entrySchema = z.object({
  position: z.tuple(noticePositionItems),
  receiptId: receiptSchema.shape.id,
  bindingId: bindingSchema.shape.bindingId,
  receivedAt: z.number(),
});
export type AdmissionIndexEntry = z.infer<typeof entrySchema>;
const filenameSchema = z.tuple([entrySchema.shape.receivedAt, ...noticePositionItems]);
const headSchema = z.object({ format: z.literal(1), seq: z.number().int().nonnegative() });
const indexRoot = (root: string) => join(root, 'admission-notice-index');
const commitPath = (root: string, seq: number) => join(indexRoot(root), 'commits', `${seq}.json`);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function compareAdmissionPositions(a: AdmissionPosition, b: AdmissionPosition): number {
  return (
    a[0] - b[0] ||
    (a[1] === b[1] ? 0 : a[1] === null ? 1 : b[1] === null ? -1 : a[1] < b[1] ? -1 : 1)
  );
}

async function entriesForReceipt(
  root: string,
  receipt: Receipt,
  documents?: Record<string, unknown>
): Promise<AdmissionIndexEntry[]> {
  if (receipt.deliveryId === null) return [];
  const entries: AdmissionIndexEntry[] = [];
  for (const binding of receipt.bindings) {
    for (const id of binding.requestIds) {
      const path = pathFor('requests', id);
      // Skipped requests are terminal. Only newly written requests can add notices;
      // later receipt preparation updates must not re-read its retained requests.
      if (documents !== undefined && !(path in documents)) continue;
      const request = requestSchema.parse(documents?.[path] ?? (await readJson(join(root, path))));
      if (request.status !== 'skipped') continue;
      entries.push({
        position: [request.position, request.id],
        receiptId: receipt.id,
        bindingId: binding.bindingId,
        receivedAt: Date.parse(receipt.receivedAt),
      });
    }
  }
  return entries;
}

async function publishEntries(root: string, entries: AdmissionIndexEntry[]): Promise<void> {
  const commits = new Map<number, AdmissionIndexEntry[]>();
  for (const entry of entries) {
    const seq = entry.position[0];
    const rows = commits.get(seq) ?? [];
    rows.push(entry);
    commits.set(seq, rows);
    const name = encodeURIComponent(JSON.stringify([entry.receivedAt, ...entry.position]));
    await replaceJson(join(indexRoot(root), 'days', day(entry.receivedAt), `${name}.json`), entry);
  }
  if (entries.length) await syncDirectory(join(indexRoot(root), 'days'));
  for (const [seq, rows] of commits) {
    rows.sort((a, b) => compareAdmissionPositions(a.position, b.position));
    await replaceJson(commitPath(root, seq), rows);
  }
}

async function indexHead(root: string) {
  const raw = await readJson(join(indexRoot(root), 'head.json'));
  return raw === undefined ? undefined : headSchema.parse(raw);
}

/** Disposable pointers only: the selected page still reads the original receipt and request. */
export async function ensureAdmissionNoticeIndex(root: string, seq: number): Promise<void> {
  if ((await indexHead(root))?.seq === seq) return;
  await rm(indexRoot(root), { recursive: true, force: true });
  const entries: AdmissionIndexEntry[] = [];
  for (const path of await documentPaths(root, 'receipts')) {
    entries.push(
      ...(await entriesForReceipt(root, receiptSchema.parse(await readJson(join(root, path)))))
    );
  }
  await publishEntries(root, entries);
  await replaceJson(join(indexRoot(root), 'head.json'), { format: 1, seq });
}

/** Called under the commit lock; redo is idempotent and older writers invalidate the index. */
export async function updateAdmissionNoticeIndex(
  root: string,
  previousSeq: number,
  seq: number,
  documents: Record<string, unknown>
): Promise<void> {
  const head = await indexHead(root);
  if (head?.seq === seq || head?.seq !== previousSeq) return;
  const entries: AdmissionIndexEntry[] = [];
  for (const [path, raw] of Object.entries(documents)) {
    if (path.startsWith('resource/receipts/'))
      entries.push(...(await entriesForReceipt(root, receiptSchema.parse(raw), documents)));
  }
  await publishEntries(root, entries);
  await replaceJson(join(indexRoot(root), 'head.json'), { format: 1, seq });
}

export async function admissionEntriesAt(
  root: string,
  seq: number
): Promise<AdmissionIndexEntry[]> {
  const raw = await readJson(commitPath(root, seq));
  return raw === undefined ? [] : z.array(entrySchema).parse(raw);
}

async function names(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function admissionEntriesSince(
  root: string,
  since: Date,
  lower: AdmissionPosition,
  upper: AdmissionPosition,
  limit: number
): Promise<AdmissionIndexEntry[]> {
  const candidates: { position: AdmissionPosition; path: string }[] = [];
  const days = join(indexRoot(root), 'days');
  const time = since.getTime();
  for (const date of await names(days)) {
    if (date < day(time)) continue;
    for (const name of (await names(join(days, date))).filter(name => name.endsWith('.json'))) {
      const [at, seq, id] = filenameSchema.parse(JSON.parse(decodeURIComponent(name.slice(0, -5))));
      const position: AdmissionPosition = [seq, id];
      if (
        at >= time &&
        compareAdmissionPositions(position, lower) > 0 &&
        compareAdmissionPositions(position, upper) <= 0
      )
        candidates.push({ position, path: join(days, date, name) });
    }
  }
  candidates.sort((a, b) => compareAdmissionPositions(a.position, b.position));
  return Promise.all(
    candidates.slice(0, limit).map(async row => entrySchema.parse(await readJson(row.path)))
  );
}
