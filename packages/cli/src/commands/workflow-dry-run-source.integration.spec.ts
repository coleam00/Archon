// @archon-test-isolated
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { packTreePath, receiptPath } from '@archon/plugin-manifest/store';
import { dryRunResultSchema, type DryRunResult } from '@archon/workflows/dry-run';
import { workflowRunCommand } from './workflow-run-owned';
import { captureWorkflowCommand } from '../test-support/command';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempTree(root);
});

interface Fixture {
  source: string;
  target: string;
  home: string;
}

/** A workflow source and a target that share nothing, as with a pack kept outside the repo. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'archon-dry-run-source-'));
  roots.push(root);
  const fx = {
    source: join(root, 'source'),
    target: join(root, 'target'),
    home: join(root, 'home'),
  };
  for (const dir of Object.values(fx)) mkdirSync(dir, { recursive: true });
  return fx;
}

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

async function dryRun(
  fx: Fixture,
  workflow: string,
  source: string | null = fx.source
): Promise<DryRunResult> {
  // The JSON result goes through process.stdout.write, which captureCommand does not see.
  let json = '';
  const write = spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ) => {
    json += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    const done = rest.find(arg => typeof arg === 'function') as (() => void) | undefined;
    done?.();
    return true;
  }) as typeof process.stdout.write);
  let result: Awaited<ReturnType<typeof captureWorkflowCommand>>;
  try {
    result = await captureWorkflowCommand(fx.home, async host => {
      await workflowRunCommand(host, fx.target, workflow, '', {
        ...(source === null ? {} : { discoveryCwd: source }),
        dryRun: true,
        defaultStubs: true,
        json: true,
      });
    });
  } finally {
    write.mockRestore();
  }
  if (!json.trim()) throw new Error(`No dry-run result in output:\n${result.output}`);
  return dryRunResultSchema.parse(JSON.parse(json));
}

describe('workflow run --dry-run --workflow-source', () => {
  test("reads a pack's packaged command from the workflow source, not --cwd", async () => {
    const fx = fixture();
    const workflowDir = join(fx.source, '.archon', 'workflows', 'demo-pack', 'probe');
    write(
      join(workflowDir, 'probe.yaml'),
      'name: probe\ndescription: probe\nnodes:\n  - id: probe\n    command: probe\n'
    );
    write(join(workflowDir, 'commands', 'probe.md'), 'Probe the target.\n');

    const result = await dryRun(fx, 'probe');

    expect(result.trace.find(entry => entry.nodeId === 'probe')?.reason).toBeUndefined();
    expect(result.outcome).toBe('completed');
  });

  test("honours the workflow source's commands.folder", async () => {
    const fx = fixture();
    write(join(fx.source, '.archon', 'config.yaml'), 'commands:\n  folder: .archon/prompts\n');
    write(join(fx.source, '.archon', 'prompts', 'hello.md'), 'Say hello.\n');
    write(
      join(fx.source, '.archon', 'workflows', 'hello.yaml'),
      'name: hello\ndescription: hello\nnodes:\n  - id: hello\n    command: hello\n'
    );

    const result = await dryRun(fx, 'hello');

    expect(result.trace.find(entry => entry.nodeId === 'hello')?.reason).toBeUndefined();
    expect(result.outcome).toBe('completed');
  });

  test('runs a source file that replaces a bundled workflow of the same name', async () => {
    const fx = fixture();
    write(
      join(fx.source, '.archon', 'workflows', 'archon-plan.yaml'),
      'name: archon-plan\ndescription: local\nnodes:\n  - id: local-only\n    bash: echo local\n'
    );

    const result = await dryRun(fx, 'archon-plan');

    expect(result.trace.map(entry => entry.nodeId)).toEqual(['local-only']);
    expect(result.outcome).toBe('completed');
  });

  test('a captured run of that replacement records project as its dispatch source', async () => {
    const fx = fixture();
    write(
      join(fx.source, '.archon', 'workflows', 'archon-plan.yaml'),
      'name: archon-plan\ndescription: local\nnodes:\n  - id: local-only\n    bash: echo local-5826\n'
    );

    const result = await captureWorkflowCommand(fx.home, async host => {
      await workflowRunCommand(host, fx.target, 'archon-plan', '', {
        discoveryCwd: fx.source,
        noWorktree: true,
        folder: true,
      });
    });

    expect(result.status, result.output).toBe(0);
    const db = new Database(join(fx.home, 'archon.db'), { readonly: true });
    try {
      const rows = db
        .query<{ metadata: string }, []>('SELECT metadata FROM remote_agent_workflow_runs')
        .all();
      expect(rows.map(row => JSON.parse(row.metadata).dispatch?.source)).toEqual(['project']);
    } finally {
      db.close();
    }
  });

  /** A pack author's checkout: the pack's manifest at the root, no `.archon/` layout. */
  function writePackFolder(fx: Fixture, nodes: string): void {
    write(
      join(fx.source, 'archon-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'workflow-pack',
        name: 'demo-pack',
        description: 'demo',
        entrypoints: { probe: 'probe/probe.yaml' },
      })
    );
    write(
      join(fx.source, 'probe', 'probe.yaml'),
      `name: probe\ndescription: probe\nnodes:\n${nodes}`
    );
    write(join(fx.source, 'probe', 'commands', 'probe.md'), 'Probe the target.\n');
  }

  test("reads a pack folder given as the source as that pack, with the pack's command", async () => {
    const fx = fixture();
    writePackFolder(fx, '  - id: probe\n    command: probe\n');

    const result = await dryRun(fx, 'probe');

    expect(result.trace.find(entry => entry.nodeId === 'probe')?.reason).toBeUndefined();
    expect(result.outcome).toBe('completed');
  });

  /** The same pack installed as `acme/demo-pack`, the way `archon plugin add` leaves it. */
  function installDemoPack(fx: Fixture): void {
    const pluginsDir = join(fx.home, 'plugins');
    const id = 'acme/demo-pack';
    const commit = 'a'.repeat(40);
    const manifest = {
      schemaVersion: 1,
      kind: 'workflow-pack',
      name: 'demo-pack',
      description: 'demo',
      entrypoints: { probe: 'probe/probe.yaml' },
    };
    const tree = packTreePath(pluginsDir, id, commit);
    write(join(tree, 'archon-plugin.json'), JSON.stringify(manifest));
    write(
      join(tree, 'probe', 'probe.yaml'),
      'name: probe\ndescription: installed\nnodes:\n  - id: probe\n    bash: echo installed\n'
    );
    write(
      receiptPath(pluginsDir, id),
      JSON.stringify({
        schemaVersion: 1,
        id,
        manifest,
        commit,
        installedAt: new Date(0).toISOString(),
      })
    );
  }

  test('a captured run of a pack folder source names the copy it ran and the installed one', async () => {
    const fx = fixture();
    writePackFolder(fx, '  - id: probe\n    bash: echo local-6034\n');
    installDemoPack(fx);

    // Under --json the copy report goes to stderr; stdout carries only the run's payload.
    const stdoutWrite = spyOn(process.stdout, 'write').mockImplementation(((
      _chunk: string | Uint8Array,
      ...rest: unknown[]
    ) => {
      (rest.find(arg => typeof arg === 'function') as (() => void) | undefined)?.();
      return true;
    }) as typeof process.stdout.write);
    let result: Awaited<ReturnType<typeof captureWorkflowCommand>>;
    try {
      result = await captureWorkflowCommand(fx.home, async host => {
        await workflowRunCommand(host, fx.target, 'probe', '', {
          discoveryCwd: fx.source,
          noWorktree: true,
          folder: true,
          json: true,
        });
      });
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(result.status, result.output).toBe(0);
    expect(result.stderr).toContain(`Pack 'demo-pack' loaded from ${fx.source}`);
    expect(result.stderr).toContain(
      "To run it, drop --workflow-source and name 'acme/demo-pack:probe'."
    );
    const db = new Database(join(fx.home, 'archon.db'), { readonly: true });
    try {
      const rows = db
        .query<{ metadata: string }, []>('SELECT metadata FROM remote_agent_workflow_runs')
        .all();
      expect(rows.map(row => JSON.parse(row.metadata).dispatch?.source)).toEqual(['project']);
    } finally {
      db.close();
    }
  });

  // A same-named global workflow stands in for any other scope the name could resolve from.
  function writeGlobalProbe(fx: Fixture): void {
    write(
      join(fx.home, 'workflows', 'probe.yaml'),
      'name: probe\ndescription: global\nnodes:\n  - id: probe\n    bash: echo global\n'
    );
  }

  async function refusal(fx: Fixture, source: string, workflow = 'probe'): Promise<string> {
    const result = await captureWorkflowCommand(fx.home, async host => {
      await workflowRunCommand(host, fx.target, workflow, '', {
        discoveryCwd: source,
        dryRun: true,
        defaultStubs: true,
      });
    });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('Dry-run:');
    return result.stderr;
  }

  test('refuses when the source lacks the workflow another scope has', async () => {
    const fx = fixture();
    writeGlobalProbe(fx);

    const error = await refusal(fx, fx.source);

    expect(error).toContain(`--workflow-source ${fx.source}`);
    expect(error).toContain(join(fx.source, '.archon', 'workflows'));
    expect(error).toContain('global scope');
  });

  test('names the source when the workflow is in no scope', async () => {
    const fx = fixture();
    const packFolder = join(fx.source, '.archon', 'workflows', 'demo-pack');
    mkdirSync(packFolder, { recursive: true });

    const error = await refusal(fx, packFolder, 'absent-everywhere');

    expect(error).toContain("Workflow 'absent-everywhere' not found");
    expect(error).toContain(join(packFolder, '.archon', 'workflows'));
    expect(error).toContain(`did you mean ${fx.source}?`);
  });

  test('points a pack folder passed as the source at its checkout root', async () => {
    const fx = fixture();
    writeGlobalProbe(fx);
    const packFolder = join(fx.source, '.archon', 'workflows', 'demo-pack');
    mkdirSync(packFolder, { recursive: true });

    const error = await refusal(fx, packFolder);

    expect(error).toContain(`did you mean ${fx.source}?`);
  });

  test('without a source, a global workflow still resolves and runs', async () => {
    const fx = fixture();
    writeGlobalProbe(fx);

    const result = await dryRun(fx, 'probe', null);

    expect(result.outcome).toBe('completed');
  });
});

describe('the definitions of a run on a git checkout', () => {
  function git(cwd: string, ...args: string[]): void {
    const done = Bun.spawnSync(['git', '-C', cwd, ...args]);
    if (done.exitCode !== 0) throw new Error(done.stderr.toString());
  }
  const commit = (cwd: string, message: string) =>
    git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', message);
  const sample = (node: string) =>
    `name: sample\ndescription: sample\nnodes:\n  - id: ${node}\n    bash: echo ${node}\n`;

  /** A remote with `main`, a clone of it as the target, and a second clone landing on it. */
  function landedFixture(): { fx: Fixture; upstream: string } {
    const fx = fixture();
    const remote = join(fx.source, 'remote.git');
    Bun.spawnSync(['git', 'init', '-q', '--bare', '--initial-branch=main', remote]);
    const upstream = join(fx.source, 'upstream');
    Bun.spawnSync(['git', 'clone', '-q', remote, upstream]);
    write(join(upstream, '.archon', 'workflows', 'sample.yaml'), sample('old'));
    git(upstream, 'add', '-A');
    commit(upstream, 'old');
    git(upstream, 'push', '-q', 'origin', 'main');
    return { fx, upstream };
  }

  test('a dry run refuses definitions changed both locally and on the base, as the start does', async () => {
    const { fx, upstream } = landedFixture();
    await removeTempTree(fx.target);
    Bun.spawnSync(['git', 'clone', '-q', join(fx.source, 'remote.git'), fx.target]);
    write(join(upstream, '.archon', 'workflows', 'sample.yaml'), sample('landed'));
    commit(upstream, 'landed');
    git(upstream, 'push', '-q', 'origin', 'main');
    write(join(fx.target, '.archon', 'workflows', 'sample.yaml'), sample('local'));

    const result = await captureWorkflowCommand(fx.home, async host => {
      await workflowRunCommand(host, fx.target, 'sample', '', { dryRun: true, defaultStubs: true });
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('.archon/workflows/sample.yaml: uncommitted in');
  });

  test("a dry run reads the registered project's default branch, as the start does", async () => {
    const { fx, upstream } = landedFixture();
    git(upstream, 'switch', '-qc', 'dev');
    write(join(upstream, '.archon', 'workflows', 'sample.yaml'), sample('dev'));
    commit(upstream, 'dev');
    git(upstream, 'push', '-q', 'origin', 'dev');
    await removeTempTree(fx.target);
    Bun.spawnSync(['git', 'clone', '-q', join(fx.source, 'remote.git'), fx.target]);
    await captureWorkflowCommand(fx.home, async host => {
      const { registerRepository } = await import('@archon/core/handlers/clone');
      await registerRepository(host.records.codebases, fx.target, { baseBranch: 'dev' });
    });

    const result = await dryRun(fx, 'sample', null);

    expect(result.trace.map(entry => entry.nodeId)).toEqual(['dev']);
  });

  test('a dry run traces the workflow landed on the base, as the real run would', async () => {
    const fx = fixture();
    const remote = join(fx.source, 'remote.git');
    Bun.spawnSync(['git', 'init', '-q', '--bare', '--initial-branch=main', remote]);
    const upstream = join(fx.source, 'upstream');
    Bun.spawnSync(['git', 'clone', '-q', remote, upstream]);
    write(join(upstream, '.archon', 'workflows', 'sample.yaml'), sample('old'));
    git(upstream, 'add', '-A');
    commit(upstream, 'old');
    git(upstream, 'push', '-q', 'origin', 'main');
    await removeTempTree(fx.target);
    Bun.spawnSync(['git', 'clone', '-q', remote, fx.target]);
    write(join(upstream, '.archon', 'workflows', 'sample.yaml'), sample('landed'));
    commit(upstream, 'landed');
    git(upstream, 'push', '-q', 'origin', 'main');

    const result = await dryRun(fx, 'sample', null);

    expect(result.trace.map(entry => entry.nodeId)).toEqual(['landed']);
  });

  test('a workflow pinned in place runs on a checkout with no remote', async () => {
    const fx = fixture();
    git(fx.target, 'init', '-q');
    write(
      join(fx.target, '.archon', 'workflows', 'inplace.yaml'),
      'name: inplace\ndescription: in place\nworktree:\n  enabled: false\nnodes:\n  - id: one\n    bash: echo in-place\n'
    );
    git(fx.target, 'add', '-A');
    commit(fx.target, 'base');

    const result = await captureWorkflowCommand(fx.home, async host => {
      await workflowRunCommand(host, fx.target, 'inplace', '', {});
    });

    expect(result.status, result.output).toBe(0);
  });
});
