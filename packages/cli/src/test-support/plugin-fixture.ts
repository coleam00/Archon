import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function fixtureGit(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(
    [
      'git',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      ...args,
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe' }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`);
  return stdout.trim();
}

export async function createPluginRepo(repo: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  await fixtureGit(repo, 'init', '-q');
}

export async function createReleaseRepo(
  repo: string,
  tags: readonly { tag: string; annotated?: boolean }[]
): Promise<Map<string, string>> {
  await createPluginRepo(repo);
  const commits = new Map<string, string>();
  for (const { tag, annotated } of tags) {
    await fixtureGit(repo, 'commit', '--allow-empty', '-qm', tag);
    await fixtureGit(repo, 'tag', ...(annotated ? ['-a', '-m', tag] : []), tag);
  }
  const refs = await fixtureGit(
    repo,
    'for-each-ref',
    '--format=%(refname:strip=2) %(objectname) %(*objectname)',
    'refs/tags'
  );
  for (const line of refs.split('\n')) {
    const [tag, object, peeled] = line.split(' ');
    if (tag && object) commits.set(tag, peeled || object);
  }
  await fixtureGit(repo, 'update-server-info');
  return commits;
}

export async function serveFixtureGit(
  repo: string,
  path: string,
  repositories: readonly string[] = ['owner/repo']
): Promise<Response | undefined> {
  for (const repository of repositories) {
    const prefix = `/${repository}.git/`;
    if (path.startsWith(prefix)) {
      const file = Bun.file(join(repo, '.git', path.slice(prefix.length)));
      return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
    }
  }
  return undefined;
}
