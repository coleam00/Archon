import { afterEach, describe, expect, spyOn, test } from 'bun:test';
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
});
