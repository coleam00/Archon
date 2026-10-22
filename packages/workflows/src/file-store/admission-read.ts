import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathFor, receiptSchema, type Receipt } from './admission-documents';
import { readJson } from './commit';

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
          new Set(row.bindings.map(binding => binding.bindingId)).size === row.bindings.length &&
          row.bindings.every(
            binding =>
              binding.receiptId === row.id &&
              (binding.intent
                ? binding.hostId === binding.intent.hostId &&
                  binding.bindingId === binding.intent.bindingId &&
                  binding.bindingRevision === binding.intent.bindingRevision
                : binding.status !== 'pending' &&
                  binding.status !== 'failed' &&
                  binding.status !== 'preparing')
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
