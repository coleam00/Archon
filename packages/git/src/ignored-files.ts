import { GitFailure } from './errors';
import { execFileAsync } from './exec';

export async function findIgnoredFiles(
  repoRoot: string,
  relativePaths: readonly string[]
): Promise<string[]> {
  if (relativePaths.length === 0) return [];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoRoot, 'check-ignore', '-z', '--stdin'],
      { timeout: 10_000, input: `${relativePaths.join('\0')}\0` }
    );
    return stdout.split('\0').filter(path => path.length > 0);
  } catch (error) {
    if (error instanceof GitFailure && (error.code === 1 || error.kind === 'not_repository'))
      return [];
    throw error;
  }
}
