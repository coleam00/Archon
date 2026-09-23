import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { observeCheckout, readContainerProbe, sampleCheckout } from './checkout-observation';
import {
  checkoutManifestSchema,
  type CheckoutManifest,
  type CheckoutObservation,
} from './schemas/checkout-observation';

const trackTempRoot = trackTempRoots();
// Git on Windows ignores the executable bit (core.fileMode=false) and NTFS forbids a
// newline in a file name, so the cases that assert on either are POSIX-only.
const posixOnly = process.platform === 'win32' ? test.skip : test;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function scratch(): string {
  return trackTempRoot(mkdtempSync(join(tmpdir(), 'checkout-observation-')));
}

function repo(): { dir: string; artifacts: string } {
  const root = scratch();
  const dir = join(root, 'repo');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return { dir, artifacts: join(root, 'artifacts') };
}

function commitAll(dir: string, message = 'commit'): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

async function observe(dir: string, artifacts: string): Promise<CheckoutObservation> {
  return observeCheckout(dir, { kind: 'host' }, { runId: 'run-1', artifactsDir: artifacts });
}

function readManifest(
  observation: CheckoutObservation,
  artifacts: string
): CheckoutManifest | undefined {
  if (observation.kind !== 'git' || observation.worktree.status !== 'dirty') return undefined;
  const bytes = readFileSync(join(artifacts, observation.worktree.manifest.pointer.path));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    observation.worktree.manifest.sha256
  );
  return checkoutManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
}

describe('checkout observation', () => {
  test('a directory with no enclosing repository is positively not Git', async () => {
    const dir = scratch();
    const observation = await observe(dir, join(dir, 'artifacts'));
    expect(observation.kind).toBe('not_git');
  });

  test('a repository Git cannot read is unavailable, never not Git', async () => {
    const dir = scratch();
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/archon-test-gitdir\n');
    const observation = await observe(dir, join(dir, 'artifacts'));
    expect(observation).toMatchObject({ kind: 'unavailable', reason: 'git_failed' });
  });

  test('a clean checkout records its commit and the commit tree, with no manifest', async () => {
    const { dir, artifacts } = repo();
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    commitAll(dir);
    const observation = await observe(dir, artifacts);
    expect(observation).toMatchObject({
      kind: 'git',
      commit: git(dir, 'rev-parse', 'HEAD'),
      tree: git(dir, 'rev-parse', 'HEAD^{tree}'),
      worktree: { status: 'clean' },
    });
  });

  test('an unborn branch has no commit and still identifies its files', async () => {
    const { dir, artifacts } = repo();
    writeFileSync(join(dir, 'new.txt'), 'n\n');
    const observation = await observe(dir, artifacts);
    expect(observation).toMatchObject({ kind: 'git', commit: null, tree: null });
    expect(readManifest(observation, artifacts)?.entries).toEqual([
      {
        path: 'new.txt',
        kind: 'file',
        mode: '100644',
        blob: git(dir, 'hash-object', 'new.txt'),
      },
    ]);
  });

  posixOnly('records only dirty paths, by worktree content, mode, and type', async () => {
    const { dir, artifacts } = repo();
    writeFileSync(join(dir, 'modified.txt'), 'one\n');
    writeFileSync(join(dir, 'staged.txt'), 'one\n');
    writeFileSync(join(dir, 'deleted.txt'), 'gone\n');
    writeFileSync(join(dir, 'exec.sh'), 'echo\n');
    writeFileSync(join(dir, 'same.txt'), 'same\n');
    symlinkSync('same.txt', join(dir, 'link'));
    commitAll(dir);

    writeFileSync(join(dir, 'modified.txt'), 'two\n');
    writeFileSync(join(dir, 'staged.txt'), 'two\n');
    git(dir, 'add', 'staged.txt');
    rmSync(join(dir, 'deleted.txt'));
    chmodSync(join(dir, 'exec.sh'), 0o755);
    rmSync(join(dir, 'link'));
    symlinkSync('modified.txt', join(dir, 'link'));
    writeFileSync(join(dir, 'untracked.txt'), 'u\n');
    writeFileSync(join(dir, 'line\nbreak.txt'), 'nl\n');
    const indexBefore = readFileSync(join(dir, '.git', 'index'));
    const indexMtime = statSync(join(dir, '.git', 'index')).mtimeMs;

    const observation = await observe(dir, artifacts);

    expect(observation).toMatchObject({
      kind: 'git',
      worktree: { status: 'dirty', content: 'complete', staged: 1, unstaged: 4, untracked: 2 },
    });
    const blob = (text: string): string =>
      createHash('sha1')
        .update(`blob ${String(Buffer.byteLength(text))}\0${text}`)
        .digest('hex');
    expect(readManifest(observation, artifacts)?.entries).toEqual([
      { path: 'deleted.txt', kind: 'absent' },
      { path: 'exec.sh', kind: 'file', mode: '100755', blob: blob('echo\n') },
      { path: 'line\nbreak.txt', kind: 'file', mode: '100644', blob: blob('nl\n') },
      { path: 'link', kind: 'symlink', mode: '120000', blob: blob('modified.txt') },
      { path: 'modified.txt', kind: 'file', mode: '100644', blob: blob('two\n') },
      { path: 'staged.txt', kind: 'file', mode: '100644', blob: blob('two\n') },
      { path: 'untracked.txt', kind: 'file', mode: '100644', blob: blob('u\n') },
    ]);
    // Observation never writes the index, even to refresh stat data.
    expect(readFileSync(join(dir, '.git', 'index')).equals(indexBefore)).toBe(true);
    expect(statSync(join(dir, '.git', 'index')).mtimeMs).toBe(indexMtime);
  });

  test('worktree bytes hash under the repository clean conversion', async () => {
    const { dir, artifacts } = repo();
    writeFileSync(join(dir, '.gitattributes'), '*.txt text eol=crlf\n');
    writeFileSync(join(dir, 'crlf.txt'), 'line\n');
    commitAll(dir);
    const committed = git(dir, 'rev-parse', 'HEAD:crlf.txt');
    // Same logical content written with CRLF, plus an unrelated edit so the path is dirty.
    writeFileSync(join(dir, 'crlf.txt'), 'line\r\nmore\r\n');
    git(dir, 'add', 'crlf.txt');
    git(dir, 'commit', '-q', '-m', 'crlf');
    const second = git(dir, 'rev-parse', 'HEAD:crlf.txt');
    writeFileSync(join(dir, 'crlf.txt'), 'line\r\n');
    const observation = await observe(dir, artifacts);
    const entry = readManifest(observation, artifacts)?.entries[0];
    expect(entry).toMatchObject({ path: 'crlf.txt', kind: 'file' });
    expect(entry && 'blob' in entry ? entry.blob : undefined).toBe(committed);
    expect(committed).not.toBe(second);
  });

  test('a dirty submodule makes the observation incomplete', async () => {
    const child = repo();
    writeFileSync(join(child.dir, 'x.txt'), 'x\n');
    commitAll(child.dir);
    const { dir, artifacts } = repo();
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child.dir, 'sub');
    commitAll(dir);
    writeFileSync(join(dir, 'sub', 'x.txt'), 'changed\n');
    const observation = await observe(dir, artifacts);
    expect(observation).toMatchObject({ worktree: { status: 'dirty', content: 'incomplete' } });
    expect(readManifest(observation, artifacts)?.entries).toEqual([
      { path: 'sub', kind: 'incomplete', reason: 'dirty_submodule' },
    ]);
  });

  test('a moved submodule records the commit it has checked out', async () => {
    const child = repo();
    writeFileSync(join(child.dir, 'x.txt'), 'x\n');
    commitAll(child.dir, 'one');
    writeFileSync(join(child.dir, 'x.txt'), 'two\n');
    commitAll(child.dir, 'two');
    const { dir, artifacts } = repo();
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child.dir, 'sub');
    commitAll(dir);
    git(join(dir, 'sub'), 'checkout', '-q', 'HEAD~1');
    const observation = await observe(dir, artifacts);
    expect(readManifest(observation, artifacts)?.entries).toEqual([
      {
        path: 'sub',
        kind: 'gitlink',
        mode: '160000',
        commit: git(join(dir, 'sub'), 'rev-parse', 'HEAD'),
      },
    ]);
  });

  test('a gitlink over an unpopulated directory never borrows the superproject commit', async () => {
    const child = repo();
    writeFileSync(join(child.dir, 'x.txt'), 'x\n');
    commitAll(child.dir);
    const { dir, artifacts } = repo();
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    commitAll(dir);
    // A never-initialized submodule: the index holds a gitlink, the directory has no `.git`,
    // so Git discovery from inside it would find the superproject.
    mkdirSync(join(dir, 'sub'));
    git(
      dir,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${git(child.dir, 'rev-parse', 'HEAD')},sub`
    );
    const observation = await observe(dir, artifacts);
    expect(readManifest(observation, artifacts)?.entries).toEqual([
      { path: 'sub', kind: 'incomplete', reason: 'unreadable' },
    ]);
  });

  test('a file removed from the index but still on disk is identified by its content', async () => {
    const { dir, artifacts } = repo();
    writeFileSync(join(dir, 'kept.txt'), 'one\n');
    commitAll(dir);
    git(dir, 'rm', '-q', '--cached', 'kept.txt');
    writeFileSync(join(dir, 'kept.txt'), 'two\n');
    const observation = await observe(dir, artifacts);
    expect(readManifest(observation, artifacts)?.entries).toEqual([
      {
        path: 'kept.txt',
        kind: 'file',
        mode: '100644',
        blob: git(dir, 'hash-object', 'kept.txt'),
      },
    ]);
  });

  posixOnly('a conflicted path records its worktree mode', async () => {
    const { dir, artifacts } = repo();
    writeFileSync(join(dir, 'run.sh'), 'base\n');
    chmodSync(join(dir, 'run.sh'), 0o755);
    commitAll(dir, 'base');
    git(dir, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(dir, 'run.sh'), 'other\n');
    commitAll(dir, 'other');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'run.sh'), 'main\n');
    commitAll(dir, 'main');
    const merge = Bun.spawnSync(['git', 'merge', '-q', 'other'], { cwd: dir, stderr: 'pipe' });
    expect(merge.exitCode).not.toBe(0);
    const observation = await observe(dir, artifacts);
    expect(readManifest(observation, artifacts)?.entries).toEqual([
      {
        path: 'run.sh',
        kind: 'file',
        mode: '100755',
        blob: git(dir, 'hash-object', 'run.sh'),
      },
    ]);
  });

  test('a container probe answers only with its own output; any other result is unknown', async () => {
    expect(readContainerProbe(0, 'marker\n')).toBe('marker');
    expect(readContainerProbe(0, 'none\n')).toBe('none');
    // docker exec exits 1 for "No such container", the same status a shell's "false" has.
    expect(readContainerProbe(1, '')).toBe('failed');
    expect(readContainerProbe(0, '')).toBe('failed');
    expect(readContainerProbe(-1, '')).toBe('failed');
    const observation = await observeCheckout(
      scratch(),
      { kind: 'container', containerId: 'archon-test-no-such-container' },
      { runId: 'run-1', artifactsDir: scratch() }
    );
    expect(observation).toMatchObject({ kind: 'unavailable', reason: 'probe_failed' });
  });

  test('sampling writes nothing until the sample is recorded', async () => {
    const { dir, artifacts } = repo();
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    const sample = await sampleCheckout(dir, { kind: 'host' });
    expect('worktree' in sample && sample.worktree.status).toBe('dirty');
    expect(() => statSync(artifacts)).toThrow();
  });
});
