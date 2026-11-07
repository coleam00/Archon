// @archon-test-isolated
/**
 * Pack settings at the run boundary: a run of a packaged workflow knows its pack, its
 * `$INPUTS` are layered from the pack's declaration, the project's settings file, the
 * workflow's own defaults and the supplied inputs, and the result is fixed on the run row
 * when the run starts. Driven through real discovery, the real executor and the
 * in-memory store.
 */
import { makeProvider, makeDeps, makePlatform } from './child-runs/test-utils';
import { InMemoryStore } from './child-runs/test-store';
import { providerRegistry } from '@archon/providers';
import { settlingProvider } from './test-settling-provider';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeWorkflow } from './executor';
import { hydrateResumableRun } from './run-resume';
import { discoverWorkflows } from './workflow-discovery';
import type { WorkflowDeps } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas/workflow-run';
import type { ResolvedWorkflow } from './schemas/workflow';

let cwd: string;
const originalArchonHome = process.env.ARCHON_HOME;

beforeEach(async () => {
  cwd = join(tmpdir(), `packset-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
  process.env.ARCHON_HOME = join(cwd, 'home');
});

afterEach(async () => {
  await removeTempTree(cwd);
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
});

/** A packaged workflow at `.archon/workflows/<pack>/<name>/<name>.yaml`. */
async function writePackWorkflow(pack: string, name: string, yaml: string): Promise<void> {
  const dir = join(cwd, '.archon', 'workflows', pack, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.yaml`), yaml);
}

async function writePackDeclaration(pack: string, yaml: string): Promise<void> {
  await mkdir(join(cwd, '.archon', 'workflows', pack, '.pack'), { recursive: true });
  await writeFile(join(cwd, '.archon', 'workflows', pack, '.pack', 'pack.yaml'), yaml);
}

async function writeProjectSettings(pack: string, yaml: string): Promise<void> {
  await mkdir(join(cwd, '.archon', 'packs'), { recursive: true });
  await writeFile(join(cwd, '.archon', 'packs', `${pack}.yaml`), yaml);
}

async function discover(name: string): Promise<ResolvedWorkflow> {
  const result = await discoverWorkflows(cwd, { providers: providerRegistry, loadDefaults: false });
  const wf = result.workflows.find(w => w.workflow.name === name);
  if (!wf) throw new Error(`workflow ${name} not found: ${JSON.stringify(result.errors)}`);
  return wf.workflow;
}

function recordingDeps(store: IWorkflowStore): { deps: WorkflowDeps; prompts: string[] } {
  const prompts: string[] = [];
  const provider = {
    ...makeProvider(),
    sendQuery: mock(function* (prompt: string) {
      prompts.push(prompt);
      yield { type: 'agent_message_chunk', text: 'ai-output' };
      yield { type: 'result', sessionId: 'sess', cost: 0.01, tokens: { input: 7, output: 3 } };
    }),
  };
  return {
    deps: {
      ...makeDeps(store),
      getAgentProvider: mock(() =>
        settlingProvider(provider)
      ) as unknown as WorkflowDeps['getAgentProvider'],
    },
    prompts,
  };
}

function runNamed(store: InMemoryStore, name: string): WorkflowRun | undefined {
  return [...store.runs.values()].find(r => r.workflow_name === name);
}

function nodeOutput(store: InMemoryStore, runId: string | undefined, step: string): string {
  const event = store.events.find(
    e => e.workflow_run_id === runId && e.event_type === 'node_completed' && e.step_name === step
  );
  return String(event?.data?.node_output);
}

function dispatchOf(run: WorkflowRun | undefined): Record<string, unknown> | undefined {
  return run?.metadata?.dispatch as Record<string, unknown> | undefined;
}

describe('a packaged run reads its pack settings as $INPUTS', () => {
  it('layers pack default < workflow default < project file < supplied input, and records the pack', async () => {
    await writePackDeclaration(
      'alpha',
      `
inputs:
  only_pack:
    default: from-pack
  project_set:
    default: from-pack
  workflow_set:
    default: from-pack
  supplied:
    default: from-pack
  workflow_only:
    default: from-pack
`
    );
    await writeProjectSettings(
      'alpha',
      `
settings:
  project_set: from-project
  workflow_set: from-project
  supplied: from-project
`
    );
    await writePackWorkflow(
      'alpha',
      'layered',
      `
name: layered
description: reads five settings
inputs:
  workflow_set:
    default: from-workflow
  workflow_only:
    default: from-workflow
  supplied:
    default: from-workflow
nodes:
  - id: emit
    bash: echo "a=$INPUTS_ONLY_PACK b=$INPUTS_PROJECT_SET c=$INPUTS_WORKFLOW_SET d=$INPUTS_SUPPLIED e=$INPUTS_WORKFLOW_ONLY"
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('layered'),
      'goal',
      { conversationId: 'conv-db' },
      { baseBranch: 'main', inputs: { supplied: 'from-input' } }
    );

    expect(result.success).toBe(true);
    const run = runNamed(store, 'layered');
    expect(nodeOutput(store, run?.id, 'emit')).toContain(
      'a=from-pack b=from-project c=from-project d=from-input e=from-workflow'
    );
    // Resolved once at run start and fixed on the row.
    expect(run?.metadata?.inputs).toEqual({
      only_pack: 'from-pack',
      project_set: 'from-project',
      workflow_set: 'from-project',
      supplied: 'from-input',
      workflow_only: 'from-workflow',
    });
    expect(dispatchOf(run)?.pack).toBe('alpha');
  });

  it('a flat workflow has no pack and gets no settings', async () => {
    await writeFile(
      join(cwd, '.archon', 'workflows', 'flat.yaml'),
      'name: flat\ndescription: flat\nnodes:\n  - id: emit\n    bash: echo flat\n'
    );
    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('flat'),
      'goal',
      { conversationId: 'conv-db' },
      { baseBranch: 'main' }
    );
    expect(result.success).toBe(true);
    expect(dispatchOf(runNamed(store, 'flat'))?.pack).toBeUndefined();
  });

  it('refuses to start when the project settings file holds a bad value, naming the file and key', async () => {
    await writePackDeclaration(
      'alpha',
      'inputs:\n  strict_mode:\n    type: bool\n    default: false\n'
    );
    await writeProjectSettings('alpha', 'settings:\n  strict_mode: maybe\n');
    await writePackWorkflow(
      'alpha',
      'bad-value',
      'name: bad-value\ndescription: d\nnodes:\n  - id: emit\n    bash: echo "$INPUTS_STRICT_MODE"\n'
    );

    const store = new InMemoryStore();
    const outcome = executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('bad-value'),
      'goal',
      { conversationId: 'conv-db' },
      { baseBranch: 'main' }
    );
    await expect(outcome).rejects.toThrow(join('.archon', 'packs', 'alpha.yaml'));
    await expect(outcome).rejects.toThrow('strict_mode');
    expect(runNamed(store, 'bad-value')).toBeUndefined();
  });

  it('fails a pending row handed over for the run when the project settings refuse it', async () => {
    await writePackDeclaration('alpha', 'inputs:\n  strict_mode:\n    type: bool\n');
    await writeProjectSettings('alpha', 'settings:\n  strict_mode: maybe\n');
    await writePackWorkflow(
      'alpha',
      'pending-bad',
      'name: pending-bad\ndescription: d\nnodes:\n  - id: emit\n    bash: echo hi\n'
    );
    const store = new InMemoryStore();
    const pending = await store.createWorkflowRun({
      workflow_name: 'pending-bad',
      user_message: 'goal',
      working_path: cwd,
    });

    await expect(
      executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-plat',
        cwd,
        await discover('pending-bad'),
        'goal',
        { conversationId: 'conv-db' },
        { baseBranch: 'main', preCreatedRun: pending }
      )
    ).rejects.toThrow('strict_mode');
    const row = await store.getWorkflowRun(pending.id);
    expect(row?.status).toBe('failed');
    expect(String(row?.metadata?.error)).toContain(join('.archon', 'packs', 'alpha.yaml'));
  });

  it('keeps the settings a run started with across a resume, even after the project file changes', async () => {
    await writePackDeclaration('alpha', 'inputs:\n  tone:\n    default: plain\n');
    await writeProjectSettings('alpha', 'settings:\n  tone: before\n');
    await writePackWorkflow(
      'alpha',
      'gated',
      `
name: gated
description: reads a setting after a gate
nodes:
  - id: gate
    approval:
      message: hold
  - id: after-gate
    prompt: "tone is $INPUTS.tone"
    depends_on: [gate]
`
    );

    const store = new InMemoryStore();
    const { deps, prompts } = recordingDeps(store);
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('gated'),
      'goal',
      { conversationId: 'conv-db' },
      { baseBranch: 'main' }
    );
    const run = runNamed(store, 'gated');
    expect(run?.status).toBe('paused');

    await writeProjectSettings('alpha', 'settings:\n  tone: after\n');
    store.approveGate(run!.id);
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(run!.id))!);
    expect(hydrated).not.toBeNull();
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('gated'),
      run!.user_message,
      { conversationId: 'conv-db' },
      { ...hydrated! }
    );

    const resumed = await store.getWorkflowRun(run!.id);
    expect(resumed?.status).toBe('completed');
    expect(prompts.some(p => p.includes('tone is before'))).toBe(true);
    expect(prompts.some(p => p.includes('tone is after'))).toBe(false);
    expect(dispatchOf(resumed ?? undefined)?.pack).toBe('alpha');
  });
});

describe('composition: a run reads its own pack, a child run its own', () => {
  beforeEach(async () => {
    await writePackDeclaration('alpha', 'inputs:\n  tone:\n    default: alpha-default\n');
    await writePackDeclaration('beta', 'inputs:\n  tone:\n    default: beta-default\n');
    await writeProjectSettings('alpha', 'settings:\n  tone: alpha-project\n');
    await writeProjectSettings('beta', 'settings:\n  tone: beta-project\n');
  });

  it('a block included from another pack reads only what its includer passes', async () => {
    await writePackWorkflow(
      'beta',
      'beta-block',
      `
name: beta-block
description: reads tone, which its own pack also declares as a setting
nodes:
  - id: speak
    prompt: "beta says $INPUTS.tone"
  - id: shell
    bash: echo "beta-env=$INPUTS_TONE"
    depends_on: [speak]
`
    );
    await writePackWorkflow(
      'alpha',
      'alpha-host',
      `
name: alpha-host
description: passes a literal tone to a block from another pack
nodes:
  - id: blk
    include: beta-block
    with:
      tone: passed
`
    );
    await writePackWorkflow(
      'alpha',
      'alpha-silent',
      'name: alpha-silent\ndescription: passes nothing\nnodes:\n  - id: blk\n    include: beta-block\n'
    );

    // An includer that passes nothing does not load: the block's pack supplies no value.
    const { workflows, errors } = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(workflows.map(w => w.workflow.name)).not.toContain('alpha-silent');
    expect(errors.find(e => e.filename === 'alpha-silent.yaml')?.error).toContain(
      'references missing input $INPUTS.tone'
    );

    const store = new InMemoryStore();
    const { deps, prompts } = recordingDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('alpha-host'),
      'goal',
      { conversationId: 'conv-db' },
      { baseBranch: 'main' }
    );

    expect(result.success).toBe(true);
    // The block reads what with: passed: not its own pack's value, nor the run's setting.
    expect(prompts.some(p => p.includes('beta says passed'))).toBe(true);
    const run = runNamed(store, 'alpha-host');
    expect(nodeOutput(store, run?.id, 'blk__shell')).toContain('beta-env=passed');
    // The run itself reads its own pack's setting.
    expect(run?.metadata?.inputs).toMatchObject({ tone: 'alpha-project' });
    expect(dispatchOf(run)).toMatchObject({ pack: 'alpha', inputs_resolved: true });
  });

  it("refuses an included block's raw $INPUTS_<setting> read its includer does not pass", async () => {
    await writePackWorkflow(
      'beta',
      'beta-raw',
      'name: beta-raw\ndescription: raw read\nnodes:\n  - id: shell\n    bash: echo "beta-env=$INPUTS_TONE"\n'
    );
    await writePackWorkflow(
      'beta',
      'beta-script',
      'name: beta-script\ndescription: named script read\nnodes:\n  - id: speak\n    script: speak\n    runtime: bun\n'
    );
    await mkdir(join(cwd, '.archon', 'workflows', 'beta', 'beta-script', 'scripts'), {
      recursive: true,
    });
    await writeFile(
      join(cwd, '.archon', 'workflows', 'beta', 'beta-script', 'scripts', 'speak.ts'),
      'console.log(`beta-env=${process.env.INPUTS_TONE}`);\n'
    );
    for (const block of ['beta-raw', 'beta-script']) {
      await writePackWorkflow(
        'alpha',
        `alpha-${block}`,
        `name: alpha-${block}\ndescription: passes nothing\nnodes:\n  - id: blk\n    include: ${block}\n`
      );
    }

    const { workflows, errors } = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    const loaded = workflows.map(w => w.workflow.name);
    expect(loaded).not.toContain('alpha-beta-raw');
    expect(loaded).not.toContain('alpha-beta-script');
    const rawError = errors.find(e => e.filename === 'alpha-beta-raw.yaml')?.error;
    expect(rawError).toContain("Node 'blk'");
    expect(rawError).toContain("included node 'shell'");
    expect(rawError).toContain("'INPUTS_TONE'");
    const scriptError = errors.find(e => e.filename === 'alpha-beta-script.yaml')?.error;
    expect(scriptError).toContain("included node 'speak'");
    expect(scriptError).toContain("'INPUTS_TONE'");
    // The blocks themselves still load: run directly, a workflow reads its pack raw.
    expect(loaded).toContain('beta-raw');
    expect(loaded).toContain('beta-script');
  });

  it('a workflow run directly reads its own pack setting raw', async () => {
    await writePackWorkflow(
      'beta',
      'beta-raw',
      'name: beta-raw\ndescription: raw read\nnodes:\n  - id: shell\n    bash: echo "beta-env=$INPUTS_TONE"\n'
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('beta-raw'),
      'goal',
      { conversationId: 'conv-db' },
      { baseBranch: 'main' }
    );

    expect(result.success).toBe(true);
    expect(nodeOutput(store, runNamed(store, 'beta-raw')?.id, 'shell')).toContain(
      'beta-env=beta-project'
    );
  });

  it("refuses a workflow: with: that sets the child's pack setting, typed or not", async () => {
    await writePackWorkflow(
      'beta',
      'beta-child',
      'name: beta-child\ndescription: child\nnodes:\n  - id: emit\n    bash: echo "child-tone=$INPUTS_TONE"\n'
    );
    await writePackWorkflow(
      'alpha',
      'alpha-parent',
      'name: alpha-parent\ndescription: parent\nnodes:\n  - id: sub\n    workflow: beta-child\n    with:\n      tone: true\n'
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('alpha-parent'),
      'goal',
      { conversationId: 'conv-db' },
      { baseBranch: 'main' }
    );

    expect(result.success).toBe(false);
    expect(runNamed(store, 'beta-child')).toBeUndefined();
    const failed = store.events.find(e => e.event_type === 'node_failed' && e.step_name === 'sub');
    expect(String(failed?.data?.error)).toContain("which 'with:' cannot set");
  });

  it('a workflow: child from another pack keeps its own pack and source', async () => {
    await writePackWorkflow(
      'beta',
      'beta-child',
      'name: beta-child\ndescription: child\nnodes:\n  - id: emit\n    bash: echo "child-tone=$INPUTS_TONE"\n'
    );
    await writePackWorkflow(
      'alpha',
      'alpha-parent',
      'name: alpha-parent\ndescription: parent\nnodes:\n  - id: sub\n    workflow: beta-child\n'
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('alpha-parent'),
      'goal',
      { conversationId: 'conv-db' },
      { baseBranch: 'main', source: 'project' }
    );

    expect(result.success).toBe(true);
    const child = runNamed(store, 'beta-child');
    expect(dispatchOf(child)).toMatchObject({ pack: 'beta', source: 'project' });
    expect(nodeOutput(store, child?.id, 'emit')).toContain('child-tone=beta-project');
    expect(dispatchOf(runNamed(store, 'alpha-parent'))?.pack).toBe('alpha');
  });

  it('a workflow: child whose pack declaration is invalid fails naming the declaration', async () => {
    await writePackDeclaration('gamma', 'inputs:\n  strict:\n    type: bool\n    default: maybe\n');
    await writePackWorkflow(
      'gamma',
      'gamma-child',
      'name: gamma-child\ndescription: child\nnodes:\n  - id: emit\n    bash: echo hi\n'
    );
    await writePackWorkflow(
      'alpha',
      'alpha-parent',
      'name: alpha-parent\ndescription: parent\nnodes:\n  - id: sub\n    workflow: gamma-child\n'
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('alpha-parent'),
      'goal',
      { conversationId: 'conv-db' },
      { baseBranch: 'main' }
    );

    expect(result.success).toBe(false);
    const failed = store.events.find(e => e.event_type === 'node_failed' && e.step_name === 'sub');
    expect(String(failed?.data?.error)).toContain("Sub-run workflow 'gamma-child' failed to load");
    expect(String(failed?.data?.error)).toContain('.pack/pack.yaml');
  });
});
