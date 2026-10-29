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
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { z } from 'zod';
import { isMaintainedProvider } from '@archon/provider-contract';
import {
  PROVIDER_PLUGIN_PROTOCOL,
  providerPluginDescriptorSchema,
} from '@archon/provider-contract/plugin/wire';
import {
  describeIssues,
  isMaintainedProviderPlugin,
  pluginReceiptSchema,
  providerReceiptSchema,
  type PluginReceipt,
} from './index';

const providerProtocolReceiptSchema = providerReceiptSchema.extend({
  descriptor: providerPluginDescriptorSchema.extend({ protocol: z.int().positive() }),
});

export const RECEIPT_FILE = 'receipt.json';

export function receiptPath(pluginsDir: string, id: string): string {
  return join(pluginsDir, 'installed', ...id.split('/'), RECEIPT_FILE);
}

/** The installed tree of a workflow pack at one commit. */
export function packTreePath(pluginsDir: string, id: string, commit: string): string {
  return join(pluginsDir, 'packs', ...id.split('/'), commit);
}

/** A receipt file that could not be read, parsed or validated. */
export interface BrokenReceipt {
  /** `owner/repo[/path]`, from the receipt's directory under `installed/`. */
  id: string;
  file: string;
  /** Names the plugin or receipt file and why it cannot be used. */
  message: string;
  cause?: unknown;
  unavailableReason?: 'provider-protocol';
}

export interface ReceiptScan {
  receipts: PluginReceipt[];
  broken: BrokenReceipt[];
}

/**
 * Every receipt, sorted by path. An unreadable or invalid receipt throws
 * rather than being skipped: skipping it would make an installed plugin
 * silently disappear, or let a second install claim its files.
 */
export async function readReceipts(pluginsDir: string): Promise<PluginReceipt[]> {
  const { receipts, broken } = await scanReceipts(pluginsDir);
  if (broken.length > 0) throw new Error(broken[0].message, { cause: broken[0].cause });
  return receipts;
}

/**
 * Every receipt, sorted by path, with the broken ones returned beside the valid
 * ones. Runtime loaders report and skip broken receipts; plugin commands decide
 * per command what a broken receipt blocks. File ownership checks use `readReceipts`.
 */
export async function scanReceipts(pluginsDir: string): Promise<ReceiptScan> {
  const root = join(pluginsDir, 'installed');
  // Existence is checked on its own: on Windows, Bun's recursive readdir reports a
  // missing directory as EINVAL rather than ENOENT, which would turn "nothing
  // installed" into an error on every install that never ran `archon plugin`.
  try {
    await stat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { receipts: [], broken: [] };
    throw error;
  }
  const entries = await readdir(root, { recursive: true });
  const receipts: PluginReceipt[] = [];
  const broken: BrokenReceipt[] = [];
  for (const entry of entries.sort()) {
    if (basename(entry) !== RECEIPT_FILE) continue;
    const file = join(root, entry);
    const id = dirname(entry).split(sep).join('/');
    const result = await readReceipt(file, id);
    if ('message' in result) {
      broken.push({ id, file, ...result });
    } else {
      receipts.push(result);
    }
  }
  return { receipts, broken };
}

/** The receipt, or the message saying why it cannot be used. */
async function readReceipt(
  file: string,
  id: string
): Promise<PluginReceipt | Pick<BrokenReceipt, 'message' | 'cause' | 'unavailableReason'>> {
  let contents: string;
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    return {
      message: `Cannot read plugin receipt ${file}: ${(error as Error).message}`,
      cause: error,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return { message: `Invalid JSON in plugin receipt ${file}` };
  }
  const parsed = pluginReceiptSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const provider = providerProtocolReceiptSchema.safeParse(raw);
  if (provider.success && provider.data.descriptor.protocol !== PROVIDER_PLUGIN_PROTOCOL) {
    const descriptor = provider.data.descriptor;
    const command =
      isMaintainedProvider(descriptor.id) && isMaintainedProviderPlugin(id, descriptor.id)
        ? `archon provider add ${descriptor.id}`
        : `archon plugin update ${id}`;
    return {
      unavailableReason: 'provider-protocol',
      message: `Plugin unavailable: ${id} (provider '${descriptor.id}') uses protocol ${descriptor.protocol}, but this Archon requires protocol ${PROVIDER_PLUGIN_PROTOCOL}. Run: ${command}`,
    };
  }
  return { message: `Invalid plugin receipt ${file}: ${describeIssues(parsed.error)}` };
}
