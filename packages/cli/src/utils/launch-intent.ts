import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { evidenceDigest } from '@archon/core/db/workflow-commands';
import { canonicalizeProjectPath } from '@archon/paths';

async function runtimeDigest(): Promise<string> {
  const hash = createHash('sha256');
  if (import.meta.path.includes('$bunfs')) {
    return hash.update(await readFile(process.execPath)).digest('hex');
  }
  const root = resolve(import.meta.dir, '../../../..');
  async function visit(directory: string): Promise<void> {
    for (const item of (await readdir(join(root, directory), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name)
    )) {
      if (['node_modules', '.git', 'dist'].includes(item.name)) continue;
      const relative = `${directory}/${item.name}`;
      if (item.isDirectory()) await visit(relative);
      else if (
        item.isFile() &&
        /\.(ts|json)$/.test(item.name) &&
        !/\.(test|spec)\.ts$/.test(item.name)
      ) {
        hash
          .update(relative)
          .update('\0')
          .update(await readFile(join(root, relative)))
          .update('\0');
      }
    }
  }
  for (const name of [
    'adapters',
    'cli',
    'core',
    'git',
    'isolation',
    'paths',
    'providers',
    'server',
    'workflows',
  ]) {
    await visit(`packages/${name}/src`);
    hash.update(await readFile(join(root, 'packages', name, 'package.json')));
  }
  hash.update(await readFile(join(root, 'bun.lock')));
  return hash.digest('hex');
}

export async function computeLaunchIntent(
  cwd: string,
  invocation: Record<string, unknown>
): Promise<string> {
  const workspace = await canonicalizeProjectPath(cwd);
  const revision = Bun.spawnSync(['git', '-C', workspace, 'rev-parse', 'HEAD'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const dirty =
    revision.exitCode === 0
      ? Bun.spawnSync(['git', '-C', workspace, 'diff', '--binary', 'HEAD'], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
      : undefined;
  if (dirty && dirty.exitCode !== 0) throw new Error('Cannot fingerprint workspace changes.');
  const refs =
    revision.exitCode === 0
      ? Bun.spawnSync(['git', '-C', workspace, 'show-ref', '--head'], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
      : undefined;
  if (refs && refs.exitCode !== 0) throw new Error('Cannot fingerprint workspace refs.');
  return evidenceDigest({
    version: 1,
    refsDigest: refs ? createHash('sha256').update(refs.stdout).digest('hex') : null,
    workspace,
    revision: revision.exitCode === 0 ? revision.stdout.toString().trim() : null,
    dirtyDigest: dirty ? createHash('sha256').update(dirty.stdout).digest('hex') : null,
    runtimeDigest: await runtimeDigest(),
    invocation: {
      ...invocation,
      workflowSource:
        typeof invocation.workflowSource === 'string'
          ? await canonicalizeProjectPath(invocation.workflowSource)
          : invocation.workflowSource,
    },
  });
}
