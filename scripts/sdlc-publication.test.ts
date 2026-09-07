import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  Publication,
  identity,
  loadPolicy,
  main,
  repositoryFromRemote,
  type PrIdentity,
  type Run,
} from '../.archon/workflows/sdlc/pr/scripts/publication';

const track = trackTempRoots();
const old = 'a'.repeat(40);
const head = 'b'.repeat(40);
const base = 'c'.repeat(40);
const record: PrIdentity = {
  number: 42,
  url: 'https://github.com/owner/repo/pull/42',
  repository: 'owner/repo',
  head: 'feature',
  base: 'develop',
  head_sha: old,
  base_sha: base,
  is_draft: true,
};
const preparation = {
  title: 'Fix the problem',
  body: 'Problem, change, validation',
  base: 'develop',
};

function fixture(existing = false) {
  const calls: string[][] = [];
  const state = {
    pushRemote: 'https://github.com/owner/repo.git',
    dirty: false,
    head,
    branch: 'feature',
    remote: existing ? old : '',
    pr: existing ? { ...record } : (null as PrIdentity | null),
    failGate: false,
    mutateGate: false,
    protected: false,
    isolated: true,
    staleFetch: false,
    descriptionMismatch: false,
  };
  const run: Run = async args => {
    calls.push(args);
    const command = args.join(' ');
    if (command === 'git remote get-url origin') return 'https://github.com/owner/repo.git';
    if (command === 'git remote get-url --push --all origin') return state.pushRemote;
    if (args[1] === 'status') return state.dirty ? '?? uncommitted.txt' : '';
    if (command === 'git branch --show-current') return state.branch;
    if (command === 'git rev-parse HEAD') return state.head;
    if (command === 'git rev-parse --absolute-git-dir') return '/repo/.git/worktrees/repair';
    if (command === 'git rev-parse --path-format=absolute --git-common-dir')
      return state.isolated ? '/repo/.git' : '/repo/.git/worktrees/repair';
    if (command === 'git rev-parse FETCH_HEAD')
      return state.staleFetch
        ? head
        : [...calls]
              .reverse()
              .find(a => a[1] === 'fetch')
              ?.at(-1) === 'refs/heads/develop'
          ? base
          : old;
    if (args[1] === 'check-ref-format' || args[1] === 'fetch' || args[1] === 'merge-base')
      return '';
    if (args[1] === 'ls-remote') {
      const ref = args.at(-1);
      const value = ref === 'refs/heads/develop' ? base : state.remote;
      return value ? `${value}\t${ref}` : '';
    }
    if (args[1] === 'rev-list') return '1';
    if (args[1] === 'diff') return state.protected ? 'policy/check.ts\0' : 'src/fix.ts\0';
    if (args[1] === 'switch') {
      state.branch = args[3]!;
      state.head = args[4]!;
      return '';
    }
    if (args[0] === 'fixed-gate') {
      if (state.failGate) throw new Error('Fixed gate failed');
      if (state.mutateGate) state.head = old;
      return '';
    }
    if (args[1] === 'push') {
      state.remote = head;
      if (state.pr) state.pr.head_sha = head;
      return '';
    }
    if (args[0] === 'gh' && args[1] === 'api') {
      const pr = state.pr!;
      return JSON.stringify({
        number: pr.number,
        html_url: pr.url,
        state: 'open',
        draft: pr.is_draft,
        head: { ref: pr.head, sha: pr.head_sha, repo: { full_name: pr.repository } },
        base: { ref: pr.base, sha: pr.base_sha, repo: { full_name: pr.repository } },
      });
    }
    if (args[2] === 'list') return JSON.stringify(state.pr ? [{ number: 42 }] : []);
    if (args[2] === 'view')
      return JSON.stringify(
        state.descriptionMismatch ? { ...preparation, body: 'wrong body' } : preparation
      );
    if (args[2] === 'create') {
      state.pr = { ...record, head_sha: head };
      return 'prose deliberately ignored';
    }
    throw new Error(`Unexpected test command: ${command}`);
  };
  return {
    publication: new Publication(run, track(join(tmpdir(), `publication-body-${randomUUID()}`))),
    calls,
    state,
  };
}

describe('deterministic PR publication', () => {
  test('real git cold repair gates and advances the same remote branch', async () => {
    const root = track(await mkdtemp(join(tmpdir(), 'publication-git-')));
    const seed = join(root, 'seed');
    const remote = join(root, 'remote.git');
    const clone = join(root, 'clone');
    const checkout = join(root, 'repair');
    const git = async (cwd: string, ...args: string[]): Promise<string> => {
      const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`Test git failed: ${err}`);
      return out.trim();
    };
    await git(root, 'init', '--bare', '--initial-branch=develop', remote);
    await git(root, 'init', '--initial-branch=develop', seed);
    await git(seed, 'config', 'user.name', 'Publication test');
    await git(seed, 'config', 'user.email', 'publication@example.invalid');
    await writeFile(join(seed, 'work.txt'), 'base\n');
    await git(seed, 'add', 'work.txt');
    await git(seed, 'commit', '-m', 'Create base');
    await git(seed, 'remote', 'add', 'origin', remote);
    await git(seed, 'push', 'origin', 'develop');
    await git(seed, 'switch', '-c', 'feature');
    await writeFile(join(seed, 'work.txt'), 'candidate\n');
    await git(seed, 'commit', '-am', 'Create candidate');
    await git(seed, 'push', 'origin', 'feature');
    await git(root, 'clone', remote, clone);
    await git(clone, 'config', 'user.name', 'Publication test');
    await git(clone, 'config', 'user.email', 'publication@example.invalid');
    await git(clone, 'worktree', 'add', '-b', 'repair-run', checkout, 'develop');
    let gateFails = true;
    const calls: string[][] = [];
    const run: Run = async args => {
      calls.push(args);
      if (
        args.join(' ') === 'git remote get-url origin' ||
        args.join(' ') === 'git remote get-url --push --all origin'
      )
        return 'https://github.com/owner/repo.git';
      if (args[0] === 'git') return git(checkout, ...args.slice(1));
      if (args[0] === 'fixed-gate') {
        if (gateFails) throw new Error('Mandatory gate failed');
        return '';
      }
      if (args[1] === 'api')
        return JSON.stringify({
          number: 42,
          html_url: record.url,
          state: 'open',
          draft: true,
          head: {
            ref: 'feature',
            sha: await git(remote, 'rev-parse', 'refs/heads/feature'),
            repo: { full_name: record.repository },
          },
          base: {
            ref: 'develop',
            sha: await git(remote, 'rev-parse', 'refs/heads/develop'),
            repo: { full_name: record.repository },
          },
        });
      if (args[2] === 'list') return '[{"number":42}]';
      throw new Error(`Unexpected public action: ${args.join(' ')}`);
    };
    const publication = new Publication(run, join(root, 'artifacts'));
    const original = await publication.checkout(42);
    await writeFile(join(checkout, 'work.txt'), 'repaired\n');
    await expect(publication.snapshot(null, original)).rejects.toThrow('dirty');
    await git(checkout, 'commit', '-am', 'Repair finding');
    const candidate = await publication.snapshot(
      { command: ['fixed-gate'], protected_paths: [] },
      original
    );
    await expect(publication.publish(candidate, preparation, true)).rejects.toThrow(
      'Mandatory gate'
    );
    expect(await git(remote, 'rev-parse', 'refs/heads/feature')).toBe(original.head_sha);
    gateFails = false;
    const repaired = await publication.publish(candidate, preparation, true);
    expect(repaired.number).toBe(original.number);
    expect(repaired.base_sha).toBe(original.base_sha);
    expect(repaired.head_sha).not.toBe(original.head_sha);
    expect(repaired.head_sha).toBe(await git(checkout, 'rev-parse', 'HEAD'));
    expect(await git(remote, 'rev-parse', 'refs/heads/feature')).toBe(repaired.head_sha);
    expect(calls.flat()).not.toContain('--force');
  }, 20000);

  test('new PR pins commits, uses non-main base, and reads typed identity', async () => {
    const f = fixture();
    const candidate = await f.publication.snapshot(null);
    const result = await f.publication.publish(candidate, preparation, true);
    expect(result).toEqual({ ...record, head_sha: head });
    expect(f.calls.find(a => a[1] === 'push')).toEqual([
      'git',
      'push',
      'origin',
      `${head}:refs/heads/feature`,
    ]);
    expect(f.calls.find(a => a[2] === 'create')).toContain('develop');
    expect(f.calls.flat()).not.toContain('--force');
    const yaml = Bun.YAML.parse(
      await Bun.file('.archon/workflows/sdlc/pr/archon-pr.yaml').text()
    ) as { nodes: { id: string; output_format?: { required: string[] } }[] };
    expect(Object.keys(result).sort()).toEqual(
      yaml.nodes
        .find(n => n.id === 'pr')!
        .output_format!.required.slice()
        .sort()
    );
  });

  test('existing PR updates the same number without replacement', async () => {
    const f = fixture(true);
    const result = await f.publication.publish(
      await f.publication.snapshot(null, record),
      preparation,
      true
    );
    expect(result.number).toBe(42);
    expect(result.head_sha).toBe(head);
    expect(f.calls.some(a => a[2] === 'create')).toBe(false);
  });

  test('a created PR with a different description fails readback', async () => {
    const f = fixture();
    f.state.descriptionMismatch = true;
    await expect(
      f.publication.publish(await f.publication.snapshot(null), preparation, true)
    ).rejects.toThrow('title or body');
  });

  test('refuses a separate or multiple origin push destinations', async () => {
    for (const remote of [
      'https://github.com/another/repo.git',
      'https://github.com/owner/repo.git\nhttps://github.com/another/repo.git',
    ]) {
      const f = fixture();
      f.state.pushRemote = remote;
      await expect(f.publication.snapshot(null)).rejects.toThrow('push destination');
      expect(f.calls.some(a => a[1] === 'push')).toBe(false);
    }
  });

  for (const problem of ['failGate', 'mutateGate', 'protected'] as const) {
    test(`${problem} refuses before push and create`, async () => {
      const f = fixture();
      f.state[problem] = true;
      const candidate = await f.publication.snapshot({
        command: ['fixed-gate'],
        protected_paths: ['policy'],
      });
      await expect(f.publication.publish(candidate, preparation, true)).rejects.toThrow();
      expect(f.calls.some(a => a[1] === 'push' || a[2] === 'create')).toBe(false);
    });
  }

  test('dirty work refuses at preparation and after preparation', async () => {
    const f = fixture();
    f.state.dirty = true;
    await expect(f.publication.snapshot(null)).rejects.toThrow('dirty');
    f.state.dirty = false;
    const candidate = await f.publication.snapshot(null);
    f.state.dirty = true;
    await expect(f.publication.publish(candidate, preparation, true)).rejects.toThrow('dirty');
    expect(f.calls.some(a => a[1] === 'push')).toBe(false);
  });

  test('changed local and remote heads refuse publication', async () => {
    for (const key of ['head', 'remote'] as const) {
      const f = fixture(true);
      const candidate = await f.publication.snapshot(null, record);
      f.state[key] = 'd'.repeat(40);
      await expect(f.publication.publish(candidate, preparation, true)).rejects.toThrow(
        'identity changed'
      );
      expect(f.calls.some(a => a[1] === 'push')).toBe(false);
    }
  });

  test('cold checkout and repair preserve PR and its non-main base', async () => {
    const f = fixture(true);
    f.state.branch = 'isolated-run';
    const target = await f.publication.checkout(42);
    expect(f.state.head).toBe(old);
    f.state.head = head;
    const result = await f.publication.publish(
      await f.publication.snapshot(null, target),
      preparation,
      true
    );
    expect(result).toEqual({ ...record, head_sha: head });
    expect(f.calls.some(a => a[2] === 'create')).toBe(false);
  });

  test('checkout refuses shared checkout and stale fetch', async () => {
    for (const problem of ['isolated', 'staleFetch'] as const) {
      const f = fixture(true);
      f.state[problem] = problem === 'staleFetch';
      await expect(f.publication.checkout(42)).rejects.toThrow();
      expect(f.calls.some(a => a[1] === 'switch')).toBe(false);
    }
  });

  test('repair refuses absent findings before any command', async () => {
    await expect(
      main({
        INPUTS_STAGE: 'resolve',
        INPUTS_OPERATION: 'checkout',
        INPUTS_TARGET_PR: '42',
        INPUTS_WORK_ORDER: 'Fix defect',
      })
    ).rejects.toThrow('public findings');
  });

  test('policy must be operator-owned outside checkout', async () => {
    const root = track(await mkdtemp(join(tmpdir(), 'publication-policy-')));
    const checkout = join(root, 'candidate');
    await mkdir(checkout);
    const content = JSON.stringify({
      command: ['bun', 'run', 'validate'],
      protected_paths: ['policy'],
    });
    await writeFile(join(checkout, 'policy.json'), content);
    await expect(loadPolicy(join(checkout, 'policy.json'), checkout)).rejects.toThrow('outside');
    await writeFile(join(checkout, '..policy.json'), content);
    await expect(loadPolicy(join(checkout, '..policy.json'), checkout)).rejects.toThrow('outside');
    await symlink(checkout, join(root, 'alias'), 'junction');
    await expect(loadPolicy(join(root, 'alias', 'policy.json'), checkout)).rejects.toThrow(
      'outside'
    );
    await writeFile(join(root, 'policy.json'), content);
    expect(await loadPolicy(join(root, 'policy.json'), checkout)).toEqual(JSON.parse(content));
    await writeFile(
      join(root, 'policy.json'),
      JSON.stringify({ command: ['fixed-gate'], protected_paths: ['./policy'] })
    );
    await expect(loadPolicy(join(root, 'policy.json'), checkout)).rejects.toThrow(
      'repository-relative'
    );
  });

  test('forge and structured identity reject mismatches', () => {
    expect(repositoryFromRemote('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(() => repositoryFromRemote('https://example.com/owner/repo')).toThrow('GitHub');
    expect(() => identity({ ...record, repository: 'another/repo' })).toThrow('URL');
  });
});
