import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileAsync } from '@archon/git';
import { getArchonTempPath } from '@archon/paths';

export async function withBranchLaunchSource<T>(
  repo: string,
  branch: string,
  prepare: (snapshot: string) => Promise<T>
): Promise<T> {
  const { stdout } = await execFileAsync(
    'git',
    ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`],
    { cwd: repo }
  );
  const commit = stdout.trim();
  const temp = getArchonTempPath();
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, 'branch-launch-'));
  try {
    const archive = join(root, 'source.tar');
    const snapshot = join(root, 'checkout');
    await mkdir(snapshot);
    await execFileAsync('git', ['archive', '--format=tar', `--output=${archive}`, commit], {
      cwd: repo,
    });
    await execFileAsync('tar', ['-xf', archive, '-C', snapshot]);
    return await prepare(snapshot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
