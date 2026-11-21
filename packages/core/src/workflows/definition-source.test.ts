import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import {
  DefinitionSourceError,
  discoverBindingWorkflows,
  withLayeredDefinitions,
} from './definition-source';

const track = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commitAll(repo: string, message: string): void {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', message);
}

/**
 * A remote with `dev`, an operator checkout cloned from it, and a second clone that lands
 * changes on the remote the operator has not pulled.
 */
function project(): { checkout: string; upstream: string } {
  const root = track(realpathSync(mkdtempSync(join(tmpdir(), 'archon-definitions-'))));
  const remote = join(root, 'remote.git');
  Bun.spawnSync(['git', 'init', '-q', '--bare', '--initial-branch=dev', remote]);
  const clone = (name: string): string => {
    const path = join(root, name);
    Bun.spawnSync(['git', 'clone', '-q', remote, path]);
    git(path, 'config', 'user.name', 'Test');
    git(path, 'config', 'user.email', 'test@example.com');
    return path;
  };
  const upstream = clone('upstream');
  write(upstream, '.archon/workflows/build.yaml', 'name: build\nversion: old\n');
  write(upstream, '.archon/commands/plan.md', 'old plan\n');
  write(upstream, '.archon/scripts/check.ts', 'old check\n');
  write(upstream, '.archon/workflows/pack/.pack/pack.yaml', 'settings: {depth: 1}\n');
  write(
    upstream,
    '.archon/config.yaml',
    'aliases: {"@fast": {provider: claude, model: old-model}}\n'
  );
  write(upstream, '.gitignore', '.archon/workflows/scratch/\n');
  write(upstream, 'src/app.ts', 'app\n');
  commitAll(upstream, 'initial');
  git(upstream, 'push', '-q', 'origin', 'dev');
  return { checkout: clone('checkout'), upstream };
}

function land(upstream: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) write(upstream, path, content);
  commitAll(upstream, 'land');
  git(upstream, 'push', '-q', 'origin', 'dev');
}

/** Everything about a checkout a run must leave as it was. */
function snapshot(checkout: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(`${path}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  };
  walk(checkout);
  const index = createHash('sha256')
    .update(readFileSync(join(checkout, '.git', 'index')))
    .digest('hex');
  return JSON.stringify({
    head: git(checkout, 'rev-parse', 'HEAD'),
    branches: git(checkout, 'for-each-ref', 'refs/heads'),
    // No optional locks: a plain status would rewrite the index this compares.
    status: git(checkout, '--no-optional-locks', 'status', '--porcelain', '--ignored'),
    index,
    files: files.sort(),
    indexMtime: statSync(join(checkout, '.git', 'index')).mtimeMs,
  });
}

/** The composed files, read while the composition exists. */
const compose = (checkout: string) =>
  withLayeredDefinitions({ checkout }, async composed => {
    const files = new Map<string, string>();
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(join(dir, entry.name), path);
        else files.set(path, readFileSync(join(dir, entry.name), 'utf8'));
      }
    };
    walk(composed.root, '');
    return {
      definitions: composed.definitions,
      read: (path: string): string | undefined => files.get(path),
      hasApp: files.has('src/app.ts'),
    };
  });

const refusal = async (checkout: string): Promise<DefinitionSourceError> => {
  const error = await compose(checkout).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DefinitionSourceError);
  return error as DefinitionSourceError;
};

describe("a run's definitions", () => {
  test('come from the base branch the checkout has not pulled', async () => {
    const { checkout, upstream } = project();
    land(upstream, {
      '.archon/workflows/build.yaml': 'name: build\nversion: new\n',
      '.archon/commands/plan.md': 'new plan\n',
      '.archon/scripts/check.ts': 'new check\n',
      '.archon/workflows/pack/.pack/pack.yaml': 'settings: {depth: 2}\n',
      '.archon/config.yaml': 'aliases: {"@fast": {provider: claude, model: new-model}}\n',
      'src/app.ts': 'new app\n',
    });
    const before = snapshot(checkout);

    const { definitions, read, hasApp } = await compose(checkout);

    expect(read('.archon/workflows/build.yaml')).toContain('version: new');
    expect(read('.archon/commands/plan.md')).toBe('new plan\n');
    expect(read('.archon/scripts/check.ts')).toBe('new check\n');
    expect(read('.archon/workflows/pack/.pack/pack.yaml')).toContain('depth: 2');
    expect(read('.archon/config.yaml')).toContain('new-model');
    // Only definitions are composed; the code comes from the run's own checkout.
    expect(hasApp).toBe(false);
    expect(definitions).toMatchObject({
      from: 'base',
      remote: 'origin',
      branch: 'dev',
      commit: git(upstream, 'rev-parse', 'HEAD'),
      checkout,
      local_files: [],
    });
    expect(snapshot(checkout)).toBe(before);
  });

  test("carry the checkout's uncommitted, untracked and ignored changes, each listed", async () => {
    const { checkout, upstream } = project();
    land(upstream, { 'src/app.ts': 'new app\n' });
    write(
      checkout,
      '.archon/config.yaml',
      'aliases: {"@fast": {provider: claude, model: local-model}}\n'
    );
    write(checkout, '.archon/workflows/trial.yaml', 'name: trial\n');
    write(checkout, '.archon/workflows/scratch/notes.md', 'ignored\n');
    rmSync(join(checkout, '.archon/commands/plan.md'));
    write(checkout, 'src/app.ts', 'local code edit\n');
    const before = snapshot(checkout);

    const { definitions, read } = await compose(checkout);

    expect(read('.archon/config.yaml')).toContain('local-model');
    expect(read('.archon/workflows/trial.yaml')).toBe('name: trial\n');
    expect(read('.archon/workflows/scratch/notes.md')).toBe('ignored\n');
    expect(read('.archon/commands/plan.md')).toBeUndefined();
    expect(definitions.local_files).toEqual([
      { path: '.archon/commands/plan.md', change: 'deleted' },
      { path: '.archon/config.yaml', change: 'modified' },
      { path: '.archon/workflows/scratch/notes.md', change: 'ignored' },
      { path: '.archon/workflows/trial.yaml', change: 'added' },
    ]);
    expect(snapshot(checkout)).toBe(before);
  });

  test('refuse a file changed both in the checkout and on the base, naming both sides', async () => {
    const { checkout, upstream } = project();
    land(upstream, {
      '.archon/config.yaml': 'aliases: {"@fast": {provider: claude, model: new-model}}\n',
    });
    write(
      checkout,
      '.archon/config.yaml',
      'aliases: {"@fast": {provider: claude, model: local-model}}\n'
    );

    const error = await refusal(checkout);

    expect(error.message).toContain('.archon/config.yaml: uncommitted in');
    expect(error.message).toContain(checkout);
    expect(error.message).toContain('changed on origin/dev between');
  });

  test('take a local change the base made identically', async () => {
    const { checkout, upstream } = project();
    land(upstream, {
      '.archon/config.yaml': 'aliases: {"@fast": {provider: claude, model: new-model}}\n',
    });
    write(
      checkout,
      '.archon/config.yaml',
      'aliases: {"@fast": {provider: claude, model: new-model}}\n'
    );

    const { read } = await compose(checkout);

    expect(read('.archon/config.yaml')).toContain('new-model');
  });

  test("read the base, not the checkout's branch, for a file committed there and not changed locally", async () => {
    const { checkout, upstream } = project();
    git(checkout, 'switch', '-qc', 'feature');
    write(checkout, '.archon/workflows/build.yaml', 'name: build\nversion: feature\n');
    commitAll(checkout, 'feature workflow');
    land(upstream, { '.archon/workflows/build.yaml': 'name: build\nversion: landed\n' });

    const { read, definitions } = await compose(checkout);

    expect(read('.archon/workflows/build.yaml')).toContain('version: landed');
    expect(definitions.local_files).toEqual([]);
  });

  test('take separate local and landed files in one new directory', async () => {
    const { checkout, upstream } = project();
    land(upstream, { '.archon/workflows/new/base.yaml': 'name: base\n' });
    write(checkout, '.archon/workflows/new/local.yaml', 'name: local\n');

    const { read, definitions } = await compose(checkout);

    expect(read('.archon/workflows/new/base.yaml')).toBe('name: base\n');
    expect(read('.archon/workflows/new/local.yaml')).toBe('name: local\n');
    expect(definitions.local_files).toEqual([
      { path: '.archon/workflows/new/local.yaml', change: 'added' },
    ]);
  });

  test('keep committed definitions an archive would leave out, and follow links within the repository', async () => {
    const { checkout, upstream } = project();
    write(upstream, 'shared/build.yaml', 'name: shared\n');
    write(upstream, 'shared/steps/one.md', 'step one\n');
    symlinkSync('../../shared/build.yaml', join(upstream, '.archon/workflows/linked.yaml'));
    symlinkSync('../../shared/steps', join(upstream, '.archon/commands/steps'));
    write(upstream, '.gitattributes', '.archon export-ignore\n');
    commitAll(upstream, 'linked');
    git(upstream, 'push', '-q', 'origin', 'dev');

    const { read } = await compose(checkout);

    expect(read('.archon/workflows/build.yaml')).toContain('version: old');
    expect(read('.archon/workflows/linked.yaml')).toBe('name: shared\n');
    expect(read('.archon/commands/steps/one.md')).toBe('step one\n');
  });

  test('refuse a checkout that shares no history with the base', async () => {
    const { checkout } = project();
    git(checkout, 'switch', '-q', '--orphan', 'unrelated');
    write(checkout, 'other.txt', 'x');
    commitAll(checkout, 'unrelated');

    const error = await refusal(checkout);

    expect(error.message).toContain('shares no history with origin/dev');
  });

  test('refuse a base that cannot be fetched, naming the ref', async () => {
    const { checkout } = project();

    const error = await withLayeredDefinitions(
      { checkout, baseOverride: 'missing' },
      async () => undefined
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DefinitionSourceError);
    expect((error as Error).message).toContain('origin/missing');
  });

  test('carry an uncommitted edit made through a definition symlink, listed under the link', async () => {
    const { checkout, upstream } = project();
    write(upstream, 'shared/build.yaml', 'name: shared\n');
    rmSync(join(upstream, '.archon/workflows/build.yaml'));
    symlinkSync('../../shared/build.yaml', join(upstream, '.archon/workflows/build.yaml'));
    commitAll(upstream, 'linked');
    git(upstream, 'push', '-q', 'origin', 'dev');
    git(checkout, 'pull', '-q');
    write(checkout, 'shared/build.yaml', 'name: shared\nlocal: edit\n');

    const { read, definitions } = await compose(checkout);

    expect(read('.archon/workflows/build.yaml')).toBe('name: shared\nlocal: edit\n');
    expect(definitions.local_files).toEqual([
      { path: '.archon/workflows/build.yaml', change: 'modified' },
    ]);
  });

  test('read a pack in a submodule at the commit the base records', async () => {
    const { checkout, upstream } = project();
    const pack = join(dirname(upstream), 'pack-repo');
    mkdirSync(pack);
    git(pack, 'init', '-q', '--initial-branch=main');
    write(pack, 'build.yaml', 'name: pack-build\n');
    git(pack, 'add', '-A');
    git(pack, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'pack');
    const allow = ['-c', 'protocol.file.allow=always'];
    git(upstream, ...allow, 'submodule', 'add', '-q', pack, '.archon/workflows/subpack');
    commitAll(upstream, 'submodule');
    git(upstream, 'push', '-q', 'origin', 'dev');
    git(checkout, 'pull', '-q');
    git(checkout, ...allow, 'submodule', 'update', '-q', '--init');

    const { read } = await compose(checkout);

    expect(read('.archon/workflows/subpack/build.yaml')).toBe('name: pack-build\n');
  });

  test("a binding check reads the start's base: the project's default branch, or the item's landing branch", async () => {
    const { checkout, upstream } = project();
    const stage = (name: string) =>
      `name: ${name}\ndescription: stage\nnodes:\n  - id: one\n    bash: echo ${name}\n`;
    for (const [branch, name] of [
      ['release', 'release-stage'],
      ['landing', 'landing-stage'],
    ] as const) {
      git(upstream, 'switch', '-qc', branch, 'dev');
      write(upstream, `.archon/workflows/${name}.yaml`, stage(name));
      commitAll(upstream, name);
      git(upstream, 'push', '-q', 'origin', branch);
    }
    const deps = {
      loadConfig: async () => ({
        assistant: 'claude' as const,
        assistants: { claude: {}, codex: {} },
        commands: {},
      }),
      providers: providerRegistry,
      projectOf: async () => ({
        kind: 'repo' as const,
        name: 'project',
        default_cwd: checkout,
        default_branch: 'release',
      }),
    };
    const launch = { cwd: checkout, isolation: { kind: 'default' as const } };
    const names = async (landing?: () => Promise<string | undefined>) => {
      const read = await discoverBindingWorkflows(launch, deps, landing);
      if ('refused' in read) throw new Error(read.refused);
      return read.discovered.workflows.map(entry => entry.workflow.name);
    };

    expect(await names()).toContain('release-stage');
    const onItem = await names(async () => 'landing');
    expect(onItem).toContain('landing-stage');
    expect(onItem).not.toContain('release-stage');
  });
});
