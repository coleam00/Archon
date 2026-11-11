// @archon-test-isolated
/**
 * `archon:script` at the run boundary: a named script and an inline script import the
 * module the engine provides, in a project with no node_modules, through the real
 * executor. The preload that carries it changes nothing else about how a script runs.
 */
import { makeDeps, makePlatform } from './child-runs/test-utils';
import { InMemoryStore } from './child-runs/test-store';
import { providerRegistry } from '@archon/providers';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { executeWorkflow } from './executor';
import { discoverWorkflows } from './workflow-discovery';

let cwd: string;
const originalArchonHome = process.env.ARCHON_HOME;

beforeEach(async () => {
  cwd = join(tmpdir(), `script-api-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
  await mkdir(join(cwd, '.archon', 'scripts'), { recursive: true });
  process.env.ARCHON_HOME = join(cwd, 'home');
});

afterEach(async () => {
  await removeTempTree(cwd);
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
});

test('a named and an inline script import archon:script, and nothing else changes', async () => {
  // Bun would load this into a script started in the checkout without --no-env-file.
  await writeFile(join(cwd, '.env'), 'ARCHON_SCRIPT_API_CANARY=leaked\n');
  await writeFile(
    join(cwd, '.archon', 'scripts', 'report.ts'),
    `import { artifactsDir, emit, input, outcomes, runId } from 'archon:script';
// A process this script starts is not given the module.
const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', "await import('archon:script')"]);
emit({
  name: input('my-name'),
  run: runId() === process.env.WORKFLOW_ID,
  artifacts: artifactsDir(),
  listed: outcomes().nodes.map(node => node.node_id),
  canary: process.env.ARCHON_SCRIPT_API_CANARY ?? null,
  childImports: child.exitCode === 0,
});
`
  );
  await writeFile(
    join(cwd, '.archon', 'workflows', 'host.yaml'),
    `name: host
description: scripts that use the host API
nodes:
  - id: plain
    runtime: bun
    script: |
      console.log(JSON.stringify({ canary: process.env.ARCHON_SCRIPT_API_CANARY ?? null }))
  - id: named
    depends_on: [plain]
    runtime: bun
    script: report
    with:
      my-name: bound value
  - id: inline
    depends_on: [named]
    runtime: bun
    script: |
      import { emit, input, refuse } from 'archon:script';
      if (input('flag') !== 'true') refuse('flag was not bound');
      else emit({ ok: true });
    with:
      flag: true
`
  );
  const { workflows, errors } = await discoverWorkflows(cwd, {
    providers: providerRegistry,
    loadDefaults: false,
  });
  const host = workflows.find(found => found.workflow.name === 'host')?.workflow;
  if (!host) throw new Error(`host not discovered: ${JSON.stringify(errors)}`);
  const store = new InMemoryStore();

  const result = await executeWorkflow(
    makeDeps(store),
    makePlatform(),
    'conv-plat',
    cwd,
    host,
    'goal',
    { conversationId: 'conv-db' },
    { baseBranch: 'main' }
  );

  const output = (step: string): unknown => {
    const event = store.events.find(e => e.event_type === 'node_completed' && e.step_name === step);
    return JSON.parse(String(event?.data?.node_output));
  };
  expect(result.success).toBe(true);
  expect(output('plain')).toEqual({ canary: null });
  const named = output('named') as Record<string, unknown>;
  expect(named).toEqual({
    name: 'bound value',
    run: true,
    artifacts: expect.any(String),
    listed: ['plain', 'named', 'inline'],
    canary: null,
    childImports: false,
  });
  expect(output('inline')).toEqual({ ok: true });
  // One file per content, however many nodes the run launches.
  expect(
    await readdir(join(String(named.artifacts), RUN_ARTIFACTS_ENGINE_SUBDIR, 'script-api'))
  ).toHaveLength(1);
});
