// @archon-test-isolated
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
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

async function dryRun(fx: Fixture, workflow: string): Promise<DryRunResult> {
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
        discoveryCwd: fx.source,
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
});
