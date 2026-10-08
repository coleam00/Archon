import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { getArchonConfigPath } from '@archon/paths';
import { FileStoreUnsupportedError } from '@archon/workflows/file-store';
import { loadProviderConcurrencyCaps } from './provider-concurrency';
import { isPerUserGitHubEnabled } from '../github-auth/config';

const selectionSchema = z.looseObject({ store: z.enum(['database', 'files']).optional() });
export async function loadStoreSelection(): Promise<'database' | 'files'> {
  let content: string;
  try {
    content = await readFile(getArchonConfigPath(), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'database';
    throw error;
  }
  const selected = selectionSchema.parse(Bun.YAML.parse(content) ?? {}).store ?? 'database';
  if (selected === 'files' && process.env.DATABASE_URL)
    throw new FileStoreUnsupportedError(
      'DATABASE_URL with store: files (ambiguous storage selection)'
    );
  return selected;
}
export async function assertFileStoreConfiguration(): Promise<void> {
  if (process.env.DATABASE_URL)
    throw new FileStoreUnsupportedError(
      'DATABASE_URL with store: files (ambiguous storage selection)'
    );
  if ((await loadProviderConcurrencyCaps()).size)
    throw new FileStoreUnsupportedError('concurrency.providers (provider attempt slots)');
  if (isPerUserGitHubEnabled()) throw new FileStoreUnsupportedError('per-user GitHub credentials');
}
