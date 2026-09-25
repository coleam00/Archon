/**
 * Where installed plugins live under `ARCHON_HOME/plugins`, and the one reader
 * for their receipts. The installer writes this layout and workflow discovery
 * reads it, so both go through these functions.
 *
 *   installed/<owner>/<repo>[/<path>]/receipt.json   one per plugin
 *   packs/<owner>/<repo>[/<path>]/<commit>/          a workflow pack's tree
 *
 * Pack trees sit outside `installed/` on purpose: a pack may contain a file
 * named `receipt.json`, and the receipt walk must never read one as a receipt.
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describeIssues, pluginReceiptSchema, type PluginReceipt } from './index';

export const RECEIPT_FILE = 'receipt.json';

export function receiptPath(pluginsDir: string, id: string): string {
  return join(pluginsDir, 'installed', ...id.split('/'), RECEIPT_FILE);
}

/** The installed tree of a workflow pack at one commit. */
export function packTreePath(pluginsDir: string, id: string, commit: string): string {
  return join(pluginsDir, 'packs', ...id.split('/'), commit);
}

/**
 * Every receipt, sorted by path. An unreadable or invalid receipt throws
 * rather than being skipped: skipping it would make an installed plugin
 * silently disappear, or let a second install claim its files.
 */
export async function readReceipts(pluginsDir: string): Promise<PluginReceipt[]> {
  const root = join(pluginsDir, 'installed');
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const receipts: PluginReceipt[] = [];
  for (const entry of entries.sort()) {
    if (basename(entry) !== RECEIPT_FILE) continue;
    const file = join(root, entry);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot read plugin receipt ${file}: ${(error as Error).message}`);
    }
    const parsed = pluginReceiptSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid plugin receipt ${file}: ${describeIssues(parsed.error)}`);
    }
    receipts.push(parsed.data);
  }
  return receipts;
}
