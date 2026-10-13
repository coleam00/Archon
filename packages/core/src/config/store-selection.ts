import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { getArchonConfigPath } from '@archon/paths';
import { FileStoreUnsupportedError } from '@archon/workflows/file-store';
import { WORKFLOW_STORE_KINDS, type WorkflowStoreKind } from '@archon/workflows/store';
import { isPerUserGitHubEnabled } from '../github-auth/config';
import { loadProviderConcurrencyCaps } from './provider-concurrency';

const selectionSchema = z.looseObject({ store: z.enum(WORKFLOW_STORE_KINDS).optional() });
function refuseDatabaseUrl(): void {
  if (process.env.DATABASE_URL)
    throw new FileStoreUnsupportedError(
      'DATABASE_URL with store: files (ambiguous storage selection)'
    );
}
export async function loadStoreSelection(): Promise<WorkflowStoreKind> {
  let content: string;
  try {
    content = await readFile(getArchonConfigPath(), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'database';
    throw error;
  }
  const selected = selectionSchema.parse(Bun.YAML.parse(content) ?? {}).store ?? 'database';
  if (selected === 'files') refuseDatabaseUrl();
  return selected;
}
export async function assertFileStoreConfiguration(): Promise<void> {
  refuseDatabaseUrl();
  // Per-user GitHub routes a run through the user's stored token and scrubs the bot token.
  // Files store no user tokens, so refuse rather than run with the shared token.
  if (isPerUserGitHubEnabled())
    throw new FileStoreUnsupportedError(
      'per-user GitHub (GITHUB_APP_ID with TOKEN_ENCRYPTION_KEY)'
    );
  if ((await loadProviderConcurrencyCaps()).size)
    throw new FileStoreUnsupportedError('concurrency.providers (provider attempt slots)');
}
