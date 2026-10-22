import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { receiptSchema, type Receipt } from './admission-documents';
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

export async function listReceiptDocuments(root: string): Promise<Receipt[]> {
  const receipts: Receipt[] = [];
  for (const path of await documentPaths(root, 'receipts')) {
    try {
      receipts.push(receiptSchema.parse(await readJson(join(root, path))));
    } catch (error) {
      throw new Error(`Invalid start receipt document '${path}'`, { cause: error });
    }
  }
  return receipts;
}
