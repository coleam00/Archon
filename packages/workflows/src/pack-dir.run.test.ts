// @archon-test-isolated
/**
 * `$PACK_DIR` at the run boundary: a packaged workflow's nodes read their own pack's
 * directory in the run's source, an included block reads its own pack's, and a workflow
 * outside a pack cannot reference it. Driven through real discovery, the real executor
 * and the in-memory store.
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
import { dryRunWorkflow } from './dry-run';
import { discoverWorkflows, discoverWorkflowsWithConfig } from './workflow-discovery';
import { prepareWorkflowSource, recordSelectedWorkflow } from './run-source';
import type { WorkflowConfig, WorkflowDeps } from './deps';
import type { IWorkflowStore } from './store';
import type { ResolvedWorkflow } from './schemas/workflow';

let cwd: string;
const originalArchonHome = process.env.ARCHON_HOME;

beforeEach(async () => {
  cwd = join(tmpdir(), `packdir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
  process.env.ARCHON_HOME = join(cwd, 'home');
});

afterEach(async () => {
  await removeTempTree(cwd);
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
});

const packRoot = (pack: string): string => join(cwd, '.archon', 'workflows', pack);

/** A packaged workflow plus a `.shared/doc.md` naming its pack, so a read proves which pack it reached. */
async function writePackWorkflow(
  pack: string,
  name: string,
  yaml: string,
  commands: Record<string, string> = {}
): Promise<void> {
  const dir = join(packRoot(pack), name);
  await mkdir(join(dir, 'commands'), { recursive: true });
  await writeFile(join(dir, `${name}.yaml`), yaml);
  for (const [command, body] of Object.entries(commands)) {
    await writeFile(join(dir, 'commands', `${command}.md`), body);
  }
  await mkdir(join(packRoot(pack), '.shared'), { recursive: true });
  await writeFile(join(packRoot(pack), '.shared', 'doc.md'), `doc of ${pack}`);
}

async function discover(name: string): Promise<ResolvedWorkflow> {
  const result = await discoverWorkflows(cwd, { providers: providerRegistry, loadDefaults: false });
  const wf = result.workflows.find(w => w.workflow.name === name);
  if (!wf) throw new Error(`workflow ${name} not found: ${JSON.stringify(result.errors)}`);
  return wf.workflow;
}

function nodeOutput(store: InMemoryStore, step: string): string {
  const event = store.events.find(e => e.event_type === 'node_completed' && e.step_name === step);
  return String(event?.data?.node_output).trim();
}

/** Deps whose AI provider records each prompt and whose project env sets `env`. */
function recordingDeps(
  store: IWorkflowStore,
  env: Record<string, string> = {}
): { deps: WorkflowDeps; prompts: string[] } {
  const prompts: string[] = [];
  const provider = {
    ...makeProvider(),
    sendQuery: mock(function* (prompt: string) {
      prompts.push(prompt);
      yield { type: 'agent_message_chunk', text: 'ai-output' };
      yield { type: 'result', sessionId: 'sess', cost: 0.01, tokens: { input: 7, output: 3 } };
    }),
  };
  const base = makeDeps(store);
  return {
    deps: {
      ...base,
      getAgentProvider: mock(() =>
        settlingProvider(provider)
      ) as unknown as WorkflowDeps['getAgentProvider'],
      loadConfig: mock(
        async (): Promise<WorkflowConfig> => ({ ...(await base.loadConfig(cwd)), envVars: env })
      ),
    },
    prompts,
  };
}

describe('$PACK_DIR', () => {
  it("names the pack of the file that authored each node, in the run's source", async () => {
    await writePackWorkflow(
      'beta',
      'beta-block',
      `
name: beta-block
description: included from another pack
nodes:
  - id: read
    bash: cat "$PACK_DIR/.shared/doc.md"
`
    );
    await writePackWorkflow(
      'alpha',
      'host',
      `
name: host
description: reads its pack from every surface
nodes:
  - id: bash-read
    bash: cat "$PACK_DIR/.shared/doc.md"
  - id: env-read
    bash: cat "\${PACK_DIR}/.shared/doc.md"
  - id: script-read
    runtime: bun
    script: console.log(require('fs').readFileSync(process.env.PACK_DIR + '/.shared/doc.md', 'utf8'))
  - id: path
    bash: printf '%s' "$PACK_DIR"
  - id: ask
    prompt: "Read $PACK_DIR/.shared/doc.md"
  - id: command-ask
    command: ask
  - id: blk
    include: beta-block
`,
      { ask: 'Policy at $PACK_DIR/.shared/doc.md' }
    );

    const store = new InMemoryStore();
    // A project env value cannot stand in for the engine's.
    const { deps, prompts } = recordingDeps(store, { PACK_DIR: '/not/the/pack' });
    // Frozen the way every launching surface freezes a run's source: discovered from the
    // staged capture, which the run then moves into its own directory.
    const preparedSource = await prepareWorkflowSource(deps, { sourceRoot: cwd });
    const { workflows } = await discoverWorkflowsWithConfig(
      cwd,
      deps.loadConfig,
      providerRegistry,
      preparedSource.roots
    );
    const host = workflows.find(w => w.workflow.name === 'host')?.workflow;
    if (host === undefined) throw new Error('host not discovered from the capture');
    await recordSelectedWorkflow(preparedSource.anchor.root, host.name);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      host,
      'goal',
      { conversationId: 'conv-db' },
      { baseBranch: 'main', preparedSource }
    );

    expect(result.success).toBe(true);
    expect(nodeOutput(store, 'bash-read')).toBe('doc of alpha');
    expect(nodeOutput(store, 'env-read')).toBe('doc of alpha');
    expect(nodeOutput(store, 'script-read')).toBe('doc of alpha');
    expect(nodeOutput(store, 'blk__read')).toBe('doc of beta');

    // The run's frozen copy of the pack, not the live checkout: an edit to the live
    // pack after the run starts cannot change what a node reads.
    const packDir = nodeOutput(store, 'path');
    expect(packDir).not.toBe(packRoot('alpha'));
    expect(packDir.startsWith(process.env.ARCHON_HOME ?? '')).toBe(true);
    // Not the staged copy discovery read: the run moved it before any node ran.
    expect(packDir.startsWith(preparedSource.anchor.root)).toBe(false);
    expect(packDir.endsWith(join('workflows', 'alpha'))).toBe(true);
    expect(prompts.some(p => p.includes(`Read ${packDir}/.shared/doc.md`))).toBe(true);
    expect(prompts.some(p => p.includes(`Policy at ${packDir}/.shared/doc.md`))).toBe(true);
  });

  it('resolves in a dry run, for the included block too', async () => {
    await writePackWorkflow(
      'beta',
      'beta-block',
      'name: beta-block\ndescription: d\nnodes:\n  - id: ask\n    prompt: "Read $PACK_DIR"\n'
    );
    await writePackWorkflow(
      'alpha',
      'host',
      'name: host\ndescription: d\nnodes:\n  - id: ask\n    prompt: "Read $PACK_DIR"\n  - id: blk\n    include: beta-block\n'
    );
    const result = await dryRunWorkflow({
      workflow: await discover('host'),
      userMessage: 'goal',
      cwd,
      stubs: { ask: 'stub', blk__ask: 'stub' },
    });
    const text = (nodeId: string): string | undefined =>
      result.trace.find(entry => entry.nodeId === nodeId)?.resolvedText;
    expect(text('ask')).toBe(`Read ${packRoot('alpha')}`);
    expect(text('blk__ask')).toBe(`Read ${packRoot('beta')}`);
  });

  it('keeps each node on its own pack through nested includes and loop bodies', async () => {
    await writePackWorkflow(
      'gamma',
      'gamma-block',
      'name: gamma-block\ndescription: d\nnodes:\n  - id: read\n    bash: cat "$PACK_DIR/.shared/doc.md"\n'
    );
    await writePackWorkflow(
      'beta',
      'beta-block',
      `
name: beta-block
description: a loop body and a nested include
nodes:
  - id: loop
    loop_group:
      max_iterations: 1
      until_bash: "true"
      nodes:
        - id: body
          bash: cat "$PACK_DIR/.shared/doc.md"
  - id: nested
    include: gamma-block
`
    );
    // A block outside any pack: its command file has no pack to read.
    await mkdir(join(cwd, '.archon', 'commands'), { recursive: true });
    await writeFile(join(cwd, '.archon', 'commands', 'flat-read.md'), 'Read $PACK_DIR/x');
    await writeFile(
      join(cwd, '.archon', 'workflows', 'flat-block.yaml'),
      'name: flat-block\ndescription: d\nnodes:\n  - id: ask\n    command: flat-read\n'
    );
    await writePackWorkflow(
      'alpha',
      'host',
      'name: host\ndescription: d\nnodes:\n  - id: blk\n    include: beta-block\n  - id: flat\n    include: flat-block\n'
    );

    const store = new InMemoryStore();
    const { deps } = recordingDeps(store);
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('host'),
      'goal',
      { conversationId: 'conv-db' },
      { baseBranch: 'main' }
    );

    expect(nodeOutput(store, 'blk__loop.body')).toBe('doc of beta');
    expect(nodeOutput(store, 'blk__nested__read')).toBe('doc of gamma');
    const failed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'flat__ask'
    );
    expect(String(failed?.data?.error)).toContain('not loaded from a pack');
  });

  it("refuses $PACK_DIR passed through an include's with:, which the block would resolve in its own pack", async () => {
    await writePackWorkflow(
      'beta',
      'beta-block',
      'name: beta-block\ndescription: d\ninputs:\n  doc: {}\nnodes:\n  - id: read\n    bash: cat "$INPUTS.doc"\n'
    );
    await writePackWorkflow(
      'alpha',
      'host',
      'name: host\ndescription: d\nnodes:\n  - id: blk\n    include: beta-block\n    with: { doc: ["$PACK_DIR/.shared/doc.md"] }\n'
    );
    const result = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(result.workflows.find(w => w.workflow.name === 'host')).toBeUndefined();
    expect(result.errors.find(e => e.filename.includes('host'))?.error).toContain(
      "Node 'blk' passes $PACK_DIR through 'with:'"
    );
  });

  it('fails the load of a workflow that is not in a pack, naming the node', async () => {
    await writeFile(
      join(cwd, '.archon', 'workflows', 'flat.yaml'),
      'name: flat\ndescription: flat\nnodes:\n  - id: reader\n    bash: cat "$PACK_DIR/x"\n'
    );
    const result = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(result.workflows.find(w => w.workflow.name === 'flat')).toBeUndefined();
    const error = result.errors.find(e => e.filename === 'flat.yaml');
    expect(error?.error).toContain("Node 'reader' references $PACK_DIR");
  });
});
