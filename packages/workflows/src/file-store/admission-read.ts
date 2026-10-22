import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  pathFor,
  receiptSchema,
  requestSchema,
  type Receipt,
  type Request,
  type Binding,
  bindingInspectionSchema,
} from './admission-documents';
import { readJson } from './commit';
import type { StartBindingInspection } from '../resource-start-store';
import {
  evaluatedStartBindingStatusSchema,
  resourceStartIntentSchema,
  RESOURCE_START_METADATA_KEY,
  type ResourceStartDisposition,
} from '../schemas/resource-start';

export async function documentPaths(root: string, kind: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(root, 'resource', kind));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter(name => name.endsWith('.json')).map(name => `resource/${kind}/${name}`);
}

export async function readReceiptDocument(root: string, path: string): Promise<Receipt | null> {
  try {
    const raw = await readJson(join(root, path));
    if (raw === undefined) return null;
    return receiptSchema
      .refine(
        row =>
          pathFor('receipts', row.id) === path &&
          (row.outcome === 'matched') === row.bindings.some(binding => binding.intent !== null) &&
          new Set(row.bindings.map(binding => binding.bindingId)).size === row.bindings.length &&
          row.bindings.every(
            binding =>
              binding.receiptId === row.id &&
              (binding.intent
                ? binding.hostId === binding.intent.hostId &&
                  binding.bindingId === binding.intent.bindingId &&
                  binding.bindingRevision === binding.intent.bindingRevision &&
                  binding.status !== 'unmatched'
                : evaluatedStartBindingStatusSchema.safeParse(binding.status).success &&
                  binding.requestIds.length === 0)
          ),
        { message: 'Start receipt document identity or preparation intent is inconsistent' }
      )
      .parse(raw);
  } catch (error) {
    throw new Error(`Invalid start receipt document '${path}'`, { cause: error });
  }
}

export async function listReceiptDocuments(root: string): Promise<Receipt[]> {
  const receipts: Receipt[] = [];
  for (const path of await documentPaths(root, 'receipts')) {
    const receipt = await readReceiptDocument(root, path);
    if (!receipt) throw new Error(`Start receipt document '${path}' disappeared during listing`);
    receipts.push(receipt);
  }
  return receipts;
}

function requestBindingIdentity(
  launch: Request['launch']
): Pick<Binding, 'receiptId' | 'bindingId'> | undefined {
  return resourceStartIntentSchema.shape.receipt.parse(
    launch.run.metadata[RESOURCE_START_METADATA_KEY]
  );
}
function matchesBinding(
  origin: Pick<Binding, 'receiptId' | 'bindingId'>,
  binding: Pick<Binding, 'receiptId' | 'bindingId'>
): boolean {
  return origin.receiptId === binding.receiptId && origin.bindingId === binding.bindingId;
}
async function readReceiptMemberships(root: string, id: string) {
  const bindings: Binding[] = [];
  const errors: unknown[] = [];
  for (const path of await documentPaths(root, 'receipts')) {
    try {
      const receipt = await readReceiptDocument(root, path);
      bindings.push(
        ...(receipt?.bindings ?? []).filter(binding => binding.requestIds.includes(id))
      );
    } catch (error) {
      errors.push(error);
    }
  }
  return { bindings, errors };
}

export async function readRequestReceiptAttribution(
  root: string,
  id: string,
  request?: Pick<Request, 'id' | 'launch'>
) {
  const row =
    request ??
    requestSchema
      .pick({ id: true, launch: true })
      .parse(await readJson(join(root, pathFor('requests', id))));
  const origin = requestBindingIdentity(row.launch);
  const { bindings, errors } = await readReceiptMemberships(root, id);
  const { owners, conflicts } = requestReceiptOwners(row, id, bindings);
  // Without a forward link, a failed scan may hide an owner or a duplicate claimant.
  // Even a readable claimant cannot prove ownership until the scan succeeds.
  if (!origin) conflicts.push(...errors);
  if (origin && !owners.some(binding => matchesBinding(origin, binding))) {
    conflicts.push(await missingOriginMembership(root, id, origin.receiptId));
  }
  let receiptId: string | undefined;
  if (!origin && owners.length > 1) {
    for (const binding of owners) conflicts.push(membershipError(id, binding));
  } else if (origin || conflicts.length === 0) receiptId = owners[0]?.receiptId;
  return { receiptId, errors: [...errors, ...conflicts], conflicts };
}

function requestReceiptOwners(
  row: Pick<Request, 'id' | 'launch'>,
  id: string,
  bindings: Binding[]
) {
  const conflicts: unknown[] = [];
  const owners: Binding[] = [];
  for (const binding of bindings) {
    try {
      validateRequestBinding(row, id, binding);
      owners.push(binding);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      conflicts.push(error);
    }
  }
  return { owners, conflicts };
}

async function missingOriginMembership(
  root: string,
  id: string,
  receiptId: string
): Promise<Error> {
  const path = pathFor('receipts', receiptId);
  try {
    const receipt = await readReceiptDocument(root, path);
    return new Error(
      `Start receipt document '${path}' ${receipt ? 'cannot establish binding membership' : 'is missing'} for request '${id}'`
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
}

function membershipError(id: string, binding: Binding): Error {
  return new Error(
    `Start receipt document '${pathFor('receipts', binding.receiptId)}' has inconsistent membership for request '${id}'`
  );
}

export function validateRequestBinding(
  request: Pick<Request, 'id' | 'launch'>,
  id: string,
  binding: Binding
): void {
  const origin = requestBindingIdentity(request.launch);
  if (
    request.id !== id ||
    request.launch.run.id !== id ||
    binding.status !== 'complete' ||
    (origin && !matchesBinding(origin, binding))
  ) {
    throw membershipError(id, binding);
  }
}

export function disposition(row: Request): ResourceStartDisposition {
  if (row.status === 'admitted') return { status: 'admitted', requestId: row.id, runId: row.id };
  if ((row.status === 'queued' || row.status === 'skipped') && row.blocker)
    return { status: row.status, requestId: row.id, blocker: row.blocker };
  throw new Error(`Resource start request '${row.id}' has no executable disposition`);
}

export async function inspectBinding(
  readRequest: (id: string) => Promise<Request | null>,
  item: Binding,
  requestId: string | null = null
): Promise<StartBindingInspection> {
  const inspection = bindingInspectionSchema.parse(item);
  const request = requestId ? await readRequest(requestId) : null;
  if (request && requestId) validateRequestBinding(request, requestId, item);
  return {
    ...inspection,
    requestStatus: request?.status ?? null,
    disposition: request && request.status !== 'withdrawn' ? disposition(request) : null,
  };
}
