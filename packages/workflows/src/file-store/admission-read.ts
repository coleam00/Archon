import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  pathFor,
  receiptSchema,
  requestSchema,
  type Receipt,
  type Request,
  type Binding,
} from './admission-documents';
import { readJson } from './commit';
import {
  evaluatedStartBindingStatusSchema,
  resourceStartIntentSchema,
  RESOURCE_START_METADATA_KEY,
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
                : evaluatedStartBindingStatusSchema.safeParse(binding.status).success)
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

export async function readRequestReceiptAttribution(root: string, id: string) {
  const row = requestSchema
    .pick({ id: true, launch: true })
    .parse(await readJson(join(root, pathFor('requests', id))));
  const origin = requestBindingIdentity(row.launch);
  const { bindings, errors } = await readReceiptMemberships(root, id);
  const conflicts: Error[] = [];
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
  let receiptId: string | undefined;
  if (!origin && owners.length > 1) {
    for (const binding of owners) conflicts.push(membershipError(id, binding));
  } else receiptId = owners[0]?.receiptId;
  return { receiptId, errors: [...errors, ...conflicts], conflicts };
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
    (origin && !matchesBinding(origin, binding))
  ) {
    throw membershipError(id, binding);
  }
}
