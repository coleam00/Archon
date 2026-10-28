// @archon-test-isolated
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
import { type WorkflowRun } from './schemas/workflow-run';
import type { ResolvedWorkflow } from './schemas/workflow';

/** Inputs, returns and typed values cross the parent/child run boundary (#2470, #2637). */
// ---------------------------------------------------------------------------
// Runtime declared-input contract on `workflow:` nodes (#2470)
//
// `include:` enforces the callee's `inputs:` block at LOAD time; these lock the
// RUN-time twin so the same `with:` map is accepted or rejected identically no
// matter which surface calls the block.
// ---------------------------------------------------------------------------

describe('workflow: declared input contract at runtime (#2470)', () => {
  let cwd: string;
  const originalArchonHome = process.env.ARCHON_HOME;

  async function writeWorkflow(name: string, yaml: string): Promise<void> {
    await writeFile(join(cwd, '.archon', 'workflows', `${name}.yaml`), yaml);
  }

  async function discover(name: string): Promise<ResolvedWorkflow> {
    const result = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    const wf = result.workflows.find(w => w.workflow.name === name);
    if (!wf) throw new Error(`workflow ${name} not found: ${JSON.stringify(result.errors)}`);
    return wf.workflow;
  }

  /** A child that declares `inputs:` and echoes them, so delivery is observable. */
  async function writeDeclaringChild(
    inputsYaml: string,
    bash = 'echo "style=$INPUTS_STYLE tone=$INPUTS_TONE"'
  ): Promise<void> {
    await writeWorkflow(
      'child-declares',
      `
name: child-declares
description: child with a declared input contract
inputs:
${inputsYaml}
nodes:
  - id: emit
    bash: ${bash}
`
    );
  }

  /** The child run row spawned by `sub`, or undefined if none was created. */
  function childRun(store: InMemoryStore): WorkflowRun | undefined {
    return [...store.runs.values()].find(r => r.workflow_name === 'child-declares');
  }

  beforeEach(async () => {
    cwd = join(tmpdir(), `subin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');
  });

  afterEach(async () => {
    await removeTempTree(cwd);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  it('applies the child declared default for an omitted with: key', async () => {
    await writeDeclaringChild('  style:\n    default: strict\n  tone:\n    default: dry');
    await writeWorkflow(
      'parent-defaults',
      `
name: parent-defaults
description: supplies only one of two declared inputs
nodes:
  - id: sub
    workflow: child-declares
    with:
      style: loud
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-defaults'),
      'goal',
      { conversationId: 'conv-db' },
      // baseBranch pinned: this suite asserts input contracts, not branch
      // auto-detection; pinning it keeps every executeWorkflow level off the
      // git-detection fallback path.
      { baseBranch: 'main' }
    );

    expect(result.success).toBe(true);
    // The caller's value wins; the omitted one is filled from the child's default —
    // and the RESOLVED map (not the raw caller map) is what gets persisted, so it
    // survives a cold resume that never re-reads the parent.
    const child = childRun(store);
    expect(child?.metadata?.inputs).toEqual({ style: 'loud', tone: 'dry' });
    // Delivered to the child's shell surface as INPUTS_<UPPER_SNAKE>.
    const emitted = store.events.find(
      e => e.workflow_run_id === child?.id && e.event_type === 'node_completed'
    );
    expect(String(emitted?.data?.node_output)).toContain('style=loud tone=dry');
  });

  it('fails the node when a required child input is not supplied', async () => {
    await writeDeclaringChild('  style:\n    required: true', 'echo "style=$INPUTS_STYLE"');
    await writeWorkflow(
      'parent-missing',
      `
name: parent-missing
description: omits a required child input
nodes:
  - id: sub
    workflow: child-declares
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-missing'),
      'goal',
      { conversationId: 'conv-db' },
      // baseBranch pinned: this suite asserts input contracts, not branch
      // auto-detection; pinning it keeps every executeWorkflow level off the
      // git-detection fallback path.
      { baseBranch: 'main' }
    );

    expect(result.success).toBe(false);
    const failed = store.events.find(e => e.event_type === 'node_failed');
    expect(String(failed?.data?.error)).toContain("requires input 'style'");
    // Rejected BEFORE the child row exists — no doomed run left to clean up.
    expect(childRun(store)).toBeUndefined();
  });

  it('fails the node on a with: key the child does not declare', async () => {
    await writeDeclaringChild('  style:\n    default: strict', 'echo "style=$INPUTS_STYLE"');
    await writeWorkflow(
      'parent-undeclared',
      `
name: parent-undeclared
description: passes a key the child never declared
nodes:
  - id: sub
    workflow: child-declares
    with:
      stlye: typo
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-undeclared'),
      'goal',
      { conversationId: 'conv-db' },
      // baseBranch pinned: this suite asserts input contracts, not branch
      // auto-detection; pinning it keeps every executeWorkflow level off the
      // git-detection fallback path.
      { baseBranch: 'main' }
    );

    expect(result.success).toBe(false);
    const failed = store.events.find(e => e.event_type === 'node_failed');
    expect(String(failed?.data?.error)).toContain("does not declare input 'stlye'");
    expect(childRun(store)).toBeUndefined();
  });

  it('keeps Phase-1 passthrough for an exec child that declares no inputs', async () => {
    await writeWorkflow(
      'child-undeclared',
      `
name: child-undeclared
description: no inputs block at all
nodes:
  - id: emit
    bash: echo "v=$INPUTS_V"
`
    );
    await writeWorkflow(
      'parent-passthrough',
      `
name: parent-passthrough
description: passes anything to an undeclared child
nodes:
  - id: sub
    workflow: child-undeclared
    with:
      v: hello
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-passthrough'),
      'goal',
      { conversationId: 'conv-db' },
      // baseBranch pinned: this suite asserts input contracts, not branch
      // auto-detection; pinning it keeps every executeWorkflow level off the
      // git-detection fallback path.
      { baseBranch: 'main' }
    );

    expect(result.success).toBe(true);
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-undeclared');
    expect(child?.metadata?.inputs).toEqual({ v: 'hello' });
  });

  it('resolves declared defaults on a bare top-level run (no parent to stamp metadata)', async () => {
    // Runtime `$INPUTS` otherwise comes only from sub-run metadata, so a workflow
    // started directly would throw on its own `$INPUTS.<name>` while the identical
    // workflow invoked as a child resolved it.
    await writeWorkflow(
      'top-level-defaults',
      `
name: top-level-defaults
description: declares a defaulted input and reads it
inputs:
  style:
    default: strict
nodes:
  - id: emit
    bash: echo "style=$INPUTS_STYLE"
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('top-level-defaults'),
      'goal',
      { conversationId: 'conv-db' },
      // baseBranch pinned: this suite asserts input contracts, not branch
      // auto-detection; pinning it keeps every executeWorkflow level off the
      // git-detection fallback path.
      { baseBranch: 'main' }
    );

    expect(result.success).toBe(true);
    const emitted = store.events.find(e => e.event_type === 'node_completed');
    expect(String(emitted?.data?.node_output)).toContain('style=strict');
  });
});

// ---------------------------------------------------------------------------
// Runtime `$INPUTS` delivery into AI surfaces + cold-resume reconstitution (#2470)
// ---------------------------------------------------------------------------

describe('workflow: runtime $INPUTS delivery and cold resume (#2470)', () => {
  let cwd: string;
  const originalArchonHome = process.env.ARCHON_HOME;

  async function writeWorkflow(name: string, yaml: string): Promise<void> {
    await writeFile(join(cwd, '.archon', 'workflows', `${name}.yaml`), yaml);
  }

  async function discover(name: string): Promise<ResolvedWorkflow> {
    const result = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    const wf = result.workflows.find(w => w.workflow.name === name);
    if (!wf) throw new Error(`workflow ${name} not found: ${JSON.stringify(result.errors)}`);
    return wf.workflow;
  }

  /** Deps whose provider records every prompt it is handed, so AI-surface delivery is observable. */
  function makeRecordingDeps(store: IWorkflowStore): { deps: WorkflowDeps; prompts: string[] } {
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

  beforeEach(async () => {
    cwd = join(tmpdir(), `subdel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');
  });

  afterEach(async () => {
    await removeTempTree(cwd);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  it("substitutes the child's $INPUTS.<name> into an AI prompt surface", async () => {
    await writeWorkflow(
      'child-ai-inputs',
      `
name: child-ai-inputs
description: reads a declared input from a prompt
inputs:
  style:
    default: strict
nodes:
  - id: work
    prompt: "write it in $INPUTS.style style"
`
    );
    await writeWorkflow(
      'parent-ai-inputs',
      `
name: parent-ai-inputs
description: supplies the child input
nodes:
  - id: sub
    workflow: child-ai-inputs
    with:
      style: terse
`
    );

    const store = new InMemoryStore();
    const { deps, prompts } = makeRecordingDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-ai-inputs'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    // The caller's value reached the model; the literal token never did.
    expect(prompts.some(p => p.includes('write it in terse style'))).toBe(true);
    expect(prompts.some(p => p.includes('$INPUTS.style'))).toBe(false);
  });

  it("BRANCHES on the child's $INPUTS.<name> in a when: condition (#2453 defect 1)", async () => {
    // Reading an input in a prompt already worked; branching on one did not — the
    // ref parsed as a node called `INPUTS` and failed the node.
    await writeWorkflow(
      'child-when-inputs',
      `
name: child-when-inputs
description: branches on a declared input
inputs:
  mode:
    default: slow
nodes:
  - id: fast-path
    prompt: "ran the FAST path"
    when: "$INPUTS.mode == 'fast'"
  - id: slow-path
    prompt: "ran the SLOW path"
    when: "$INPUTS.mode != 'fast'"
`
    );
    await writeWorkflow(
      'parent-when-inputs',
      `
name: parent-when-inputs
description: supplies the branch selector
nodes:
  - id: sub
    workflow: child-when-inputs
    with:
      mode: fast
`
    );

    const store = new InMemoryStore();
    const { deps, prompts } = makeRecordingDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-when-inputs'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    expect(prompts.some(p => p.includes('ran the FAST path'))).toBe(true);
    expect(prompts.some(p => p.includes('ran the SLOW path'))).toBe(false);
  });

  it('FAILS the node when a when: references an input the run does not carry', async () => {
    await writeWorkflow(
      'child-when-unknown-input',
      `
name: child-when-unknown-input
description: branches on a misspelled input
inputs:
  mode:
    default: slow
nodes:
  - id: gated
    prompt: "should never run"
    when: "$INPUTS.mdoe == 'fast'"
`
    );
    await writeWorkflow(
      'parent-when-unknown-input',
      `
name: parent-when-unknown-input
description: supplies the declared input
nodes:
  - id: sub
    workflow: child-when-unknown-input
    with:
      mode: fast
`
    );

    const store = new InMemoryStore();
    const { deps, prompts } = makeRecordingDeps(store);
    const platform = makePlatform();
    const result = await executeWorkflow(
      deps,
      platform,
      'conv-plat',
      cwd,
      await discover('parent-when-unknown-input'),
      'goal',
      { conversationId: 'conv-db' }
    );

    // Loud, not a silent skip: the typo fails the node rather than resolving to ''.
    expect(result.success).toBe(false);
    expect(prompts.some(p => p.includes('should never run'))).toBe(false);
    const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
      .map(call => String(call[1]))
      .join('\n');
    expect(sent).toContain("Unknown input '$INPUTS.mdoe'");
    expect(sent).toContain('Did you mean $INPUTS.mode?');
  });

  it('reconstitutes $INPUTS from the child run row on a COLD resume (no parent in the loop)', async () => {
    // The child is resumed directly from its own persisted row — the parent never
    // re-resolves `with:` (its refs may be long out of scope), so a post-gate node
    // can only see `$INPUTS` if the resolved map survived on `metadata.inputs`.
    await writeWorkflow(
      'child-cold',
      `
name: child-cold
description: gated child that reads an input AFTER the gate
inputs:
  style:
    default: strict
nodes:
  - id: gate
    approval:
      message: "hold"
  - id: after-gate
    prompt: "resumed in $INPUTS.style style"
    depends_on: [gate]
`
    );
    await writeWorkflow(
      'parent-cold',
      `
name: parent-cold
description: spawns the gated child
nodes:
  - id: sub
    workflow: child-cold
    with:
      style: terse
`
    );

    const store = new InMemoryStore();
    const { deps, prompts } = makeRecordingDeps(store);
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-cold'),
      'goal',
      { conversationId: 'conv-db' }
    );

    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-cold');
    expect(child?.status).toBe('paused');
    expect(child?.metadata?.inputs).toEqual({ style: 'terse' });

    // Cold path: approve, hydrate from the persisted row alone, re-drive the child.
    store.approveGate(child!.id);
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(child!.id))!);
    expect(hydrated).not.toBeNull();
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('child-cold'),
      child!.user_message,
      { conversationId: 'conv-db' },
      { ...hydrated! }
    );

    expect((await store.getWorkflowRun(child!.id))?.status).toBe('completed');
    expect(prompts.some(p => p.includes('resumed in terse style'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Direct top-level invocation supplying its own inputs (#2554)
  // -------------------------------------------------------------------------

  it('delivers directly-supplied inputs to BOTH the AI and shell surfaces of a top-level run', async () => {
    // No parent anywhere: the values come from `opts.inputs` (the CLI's --input / the
    // run route's `inputs` map) and must reach the same two surfaces a child's do.
    await writeWorkflow(
      'direct-inputs',
      `
name: direct-inputs
description: runs on its own with a required input
inputs:
  diff:
    required: true
  style:
    default: strict
nodes:
  - id: shell
    bash: echo "diff=$INPUTS_DIFF style=$INPUTS_STYLE"
  - id: ai
    prompt: "review $INPUTS.diff in $INPUTS.style style"
    depends_on: [shell]
`
    );

    const store = new InMemoryStore();
    const { deps, prompts } = makeRecordingDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('direct-inputs'),
      'goal',
      { conversationId: 'conv-db' },
      { inputs: { diff: 'D1', style: 'terse' } }
    );

    expect(result.success).toBe(true);
    // Shell surface: env vars, never $INPUTS text spliced into shell source.
    const shellOut = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'shell'
    );
    expect(String(shellOut?.data?.node_output)).toContain('diff=D1 style=terse');
    // AI surface: substituted text, literal token never reaches the model.
    expect(prompts.some(p => p.includes('review D1 in terse style'))).toBe(true);
    expect(prompts.some(p => p.includes('$INPUTS.diff'))).toBe(false);
  });

  it('persists ONLY the supplied values on a top-level run, letting defaults stay derived', async () => {
    await writeWorkflow(
      'direct-persist',
      `
name: direct-persist
description: one supplied input, one defaulted
inputs:
  diff:
    required: true
  style:
    default: strict
nodes:
  - id: emit
    bash: echo "style=$INPUTS_STYLE"
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('direct-persist'),
      'goal',
      { conversationId: 'conv-db' },
      { inputs: { diff: 'D1' } }
    );

    expect(result.success).toBe(true);
    const run = [...store.runs.values()].find(r => r.workflow_name === 'direct-persist');
    // `style` is NOT on the row — freezing a derived default would make the row lie
    // about what the invocation supplied, and pin a stale default across a resume.
    expect(run?.metadata?.inputs).toEqual({ diff: 'D1' });
    // …yet the default still reaches the node, layered under the persisted map.
    const emitted = store.events.find(e => e.event_type === 'node_completed');
    expect(String(emitted?.data?.node_output)).toContain('style=strict');
  });

  it('a supplied value overrides the declared default on a top-level run', async () => {
    await writeWorkflow(
      'direct-override',
      `
name: direct-override
description: supplied value beats the declared default
inputs:
  style:
    default: strict
nodes:
  - id: emit
    bash: echo "style=$INPUTS_STYLE"
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('direct-override'),
      'goal',
      { conversationId: 'conv-db' },
      { inputs: { style: 'terse' } }
    );

    expect(result.success).toBe(true);
    const emitted = store.events.find(e => e.event_type === 'node_completed');
    expect(String(emitted?.data?.node_output)).toContain('style=terse');
  });

  it('writes no inputs key for a bare top-level run, preserving pre-#2554 behaviour', async () => {
    await writeWorkflow(
      'direct-bare',
      `
name: direct-bare
description: defaulted input, nothing supplied
inputs:
  style:
    default: strict
nodes:
  - id: emit
    bash: echo "style=$INPUTS_STYLE"
`
    );

    const store = new InMemoryStore();
    await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('direct-bare'),
      'goal',
      { conversationId: 'conv-db' }
    );

    const run = [...store.runs.values()].find(r => r.workflow_name === 'direct-bare');
    expect(run?.metadata?.inputs).toBeUndefined();
  });

  it('reconstitutes directly-supplied inputs on a COLD resume of a top-level run', async () => {
    // The invocation channel is gone by resume time — the CLI process exited, the HTTP
    // request completed. Only the run row can carry the values forward.
    await writeWorkflow(
      'direct-cold',
      `
name: direct-cold
description: gated top-level run reading an input AFTER the gate
inputs:
  style:
    default: strict
nodes:
  - id: gate
    approval:
      message: "hold"
  - id: after-gate
    prompt: "resumed in $INPUTS.style style"
    depends_on: [gate]
`
    );

    const store = new InMemoryStore();
    const { deps, prompts } = makeRecordingDeps(store);
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('direct-cold'),
      'goal',
      { conversationId: 'conv-db' },
      { inputs: { style: 'terse' } }
    );

    const run = [...store.runs.values()].find(r => r.workflow_name === 'direct-cold');
    expect(run?.status).toBe('paused');
    expect(run?.metadata?.inputs).toEqual({ style: 'terse' });

    // Cold path: approve, hydrate from the persisted row alone, re-drive — and pass NO
    // `inputs` this time, exactly as a resume does.
    store.approveGate(run!.id);
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(run!.id))!);
    expect(hydrated).not.toBeNull();
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('direct-cold'),
      run!.user_message,
      { conversationId: 'conv-db' },
      { ...hydrated! }
    );

    expect((await store.getWorkflowRun(run!.id))?.status).toBe('completed');
    expect(prompts.some(p => p.includes('resumed in terse style'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Runtime `returns:` rebinding on a `workflow:` sub-run (#2470)
// ---------------------------------------------------------------------------

describe('workflow: returns rebinds the child terminal output (#2470)', () => {
  let cwd: string;
  const originalArchonHome = process.env.ARCHON_HOME;

  async function writeWorkflow(name: string, yaml: string): Promise<void> {
    await writeFile(join(cwd, '.archon', 'workflows', `${name}.yaml`), yaml);
  }

  async function discover(name: string): Promise<ResolvedWorkflow> {
    const result = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    const wf = result.workflows.find(w => w.workflow.name === name);
    if (!wf) throw new Error(`workflow ${name} not found: ${JSON.stringify(result.errors)}`);
    return wf.workflow;
  }

  beforeEach(async () => {
    cwd = join(tmpdir(), `subret-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');
  });

  afterEach(async () => {
    await removeTempTree(cwd);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  it('threads the declared returns node output, not the last sink', async () => {
    // `summary` is the declared return; `cleanup` is the positional sink that would
    // otherwise supply the terminal output.
    await writeWorkflow(
      'child-returns',
      `
name: child-returns
description: declares a non-sink return node
returns: summary
nodes:
  - id: summary
    bash: echo "THE-SUMMARY"
  - id: cleanup
    bash: echo "THE-CLEANUP"
    depends_on: [summary]
`
    );
    await writeWorkflow(
      'parent-returns',
      `
name: parent-returns
description: consumes the child's declared return
nodes:
  - id: sub
    workflow: child-returns
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-returns'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-returns');
    const subCompleted = store.events.find(
      e =>
        e.workflow_run_id === parentRun?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'sub'
    );
    expect(String(subCompleted?.data?.node_output)).toContain('THE-SUMMARY');
    expect(String(subCompleted?.data?.node_output)).not.toContain('THE-CLEANUP');
  });

  it('keeps a child authored outcome on the child run without propagating it to the parent', async () => {
    await writeWorkflow(
      'child-outcome',
      `
name: child-outcome
description: child authors a failed work verdict
returns: result
outcome_field: green
nodes:
  - id: result
    prompt: report the child verdict
    output_format:
      type: object
      properties:
        green: { type: boolean }
      required: [green]
`
    );
    await writeWorkflow(
      'parent-outcome',
      `
name: parent-outcome
description: parent consumes the governed child
nodes:
  - id: sub
    workflow: child-outcome
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    deps.getAgentProvider = mock(() =>
      settlingProvider({
        ...makeProvider(),
        sendQuery: mock(function* () {
          yield { type: 'agent_message_chunk', text: '{"green":false}' };
          yield {
            type: 'result',
            sessionId: 'sess-outcome',
            structuredOutput: { green: false },
          };
        }),
      })
    ) as unknown as WorkflowDeps['getAgentProvider'];

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-outcome'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const child = [...store.runs.values()].find(run => run.workflow_name === 'child-outcome');
    const parent = [...store.runs.values()].find(run => run.workflow_name === 'parent-outcome');
    expect(child).toMatchObject({ status: 'completed', outcome: 'failed' });
    expect(parent).toMatchObject({ status: 'completed', outcome: null });
    expect(
      store.events.some(
        event =>
          event.workflow_run_id === parent?.id &&
          event.event_type === 'node_completed' &&
          event.step_name === 'sub'
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #2637 — typed value transport across the run boundary: `with:` values keep
// their logical type into the child (AC3), a child's terminal structured value
// threads back to the parent (AC6), and fan-out aggregates are logical arrays
// (single-encoded — never a JSON string that must be parsed twice).
// ---------------------------------------------------------------------------

describe('workflow: typed value transport (#2637)', () => {
  let cwd: string;
  const originalArchonHome = process.env.ARCHON_HOME;

  async function writeWorkflow(name: string, yaml: string): Promise<void> {
    await writeFile(join(cwd, '.archon', 'workflows', `${name}.yaml`), yaml);
  }

  async function discover(name: string): Promise<ResolvedWorkflow> {
    const result = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    const wf = result.workflows.find(w => w.workflow.name === name);
    if (!wf) throw new Error(`workflow ${name} not found: ${JSON.stringify(result.errors)}`);
    return wf.workflow;
  }

  /**
   * Deps whose provider branches on prompt content: a prompt containing PRODUCE
   * yields a structured payload; a prompt containing HANDLE yields per-item
   * structured/plain/failing behavior for fan-out children; everything else is
   * recorded so parent-side delivery is observable.
   */
  function makeStructuredDeps(store: IWorkflowStore): { deps: WorkflowDeps; prompts: string[] } {
    const prompts: string[] = [];
    const provider = {
      ...makeProvider(),
      sendQuery: mock(function* (prompt: string) {
        if (prompt.includes('PRODUCE')) {
          yield { type: 'agent_message_chunk', text: '{"green":true,"items":["a","b"]}' };
          yield {
            type: 'result',
            sessionId: 'sess-prod',
            structuredOutput: { green: true, items: ['a', 'b'] },
          };
          return;
        }
        if (prompt.includes('VERIFY')) {
          // A verifier-shaped payload: top-level `error` + `status` fields as DATA —
          // the natural schema the aggregate's failure marker must stay separable from.
          if (prompt.includes('bad')) throw new Error('verifier exploded');
          yield { type: 'agent_message_chunk', text: '{"error":"none found","status":"clean"}' };
          yield {
            type: 'result',
            sessionId: 'sess-verify',
            structuredOutput: { error: 'none found', status: 'clean' },
          };
          return;
        }
        if (prompt.includes('HANDLE')) {
          if (prompt.includes('bad')) throw new Error('handler exploded');
          if (prompt.includes('plain')) {
            yield { type: 'agent_message_chunk', text: 'did:plain' };
            yield { type: 'result', sessionId: 'sess-plain' };
            return;
          }
          const item = prompt.includes('alpha') ? 'alpha' : 'beta';
          yield { type: 'agent_message_chunk', text: `{"v":"${item}"}` };
          yield { type: 'result', sessionId: `sess-${item}`, structuredOutput: { v: item } };
          return;
        }
        prompts.push(prompt);
        yield { type: 'agent_message_chunk', text: 'ai-output' };
        yield { type: 'result', sessionId: 'sess' };
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

  beforeEach(async () => {
    cwd = join(tmpdir(), `subval-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');
  });

  afterEach(async () => {
    await removeTempTree(cwd);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  it('AC3: a typed with: literal reaches the child as its logical type and forwards typed into a nested with:', async () => {
    await writeWorkflow(
      'grandchild-typed',
      `
name: grandchild-typed
description: leaf that echoes the forwarded input
inputs:
  x: {}
nodes:
  - id: leaf
    bash: echo "x=$INPUTS_X"
`
    );
    await writeWorkflow(
      'child-typed',
      `
name: child-typed
description: child that echoes and forwards a typed input
inputs:
  flag: {}
  note: {}
nodes:
  - id: emit
    bash: echo "flag=$INPUTS_FLAG note=$INPUTS_NOTE"
  - id: forward
    workflow: grandchild-typed
    depends_on: [emit]
    with:
      x: $INPUTS.flag
`
    );
    await writeWorkflow(
      'parent-typed',
      `
name: parent-typed
description: supplies a boolean and a string
nodes:
  - id: sub
    workflow: child-typed
    with:
      flag: true
      note: plain
`
    );

    const store = new InMemoryStore();
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-typed'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-typed');
    // Legacy text map stays string-valued forever (old-binary compat); the logical
    // map rides the additive sibling, written because a value is non-string.
    expect(child?.metadata?.inputs).toEqual({ flag: 'true', note: 'plain' });
    expect(child?.metadata?.inputs_values).toEqual({ flag: true, note: 'plain' });
    // Env delivery is the canonical text.
    const emitted = store.events.find(
      e => e.workflow_run_id === child?.id && e.event_type === 'node_completed'
    );
    expect(String(emitted?.data?.node_output)).toContain('flag=true note=plain');
    // The whole-value `$INPUTS.flag` position forwarded the LOGICAL boolean.
    const grandchild = [...store.runs.values()].find(r => r.workflow_name === 'grandchild-typed');
    expect(grandchild?.metadata?.inputs_values).toEqual({ x: true });
    expect(grandchild?.metadata?.inputs).toEqual({ x: 'true' });
  });

  it('AC3: a whole `$node.output.field` ref in with: arrives as a logical array, single-encoded in env', async () => {
    await writeWorkflow(
      'child-items',
      `
name: child-items
description: echoes the received items input
inputs:
  items: {}
nodes:
  - id: emit
    bash: printf '%s' "items=$INPUTS_ITEMS"
`
    );
    await writeWorkflow(
      'parent-items',
      `
name: parent-items
description: passes a structured field through the with map
nodes:
  - id: plan
    prompt: PRODUCE the plan
    output_format:
      type: object
      properties:
        green: { type: boolean }
        items: { type: array }
  - id: sub
    workflow: child-items
    depends_on: [plan]
    with:
      items: $plan.output.items
`
    );

    const store = new InMemoryStore();
    const { deps } = makeStructuredDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-items'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-items');
    expect(child?.metadata?.inputs_values).toEqual({ items: ['a', 'b'] });
    const emitted = store.events.find(
      e => e.workflow_run_id === child?.id && e.event_type === 'node_completed'
    );
    // Single-encoded JSON text in the env bag — parse once, never twice.
    expect(String(emitted?.data?.node_output)).toBe('items=["a","b"]');
  });

  it("AC6: a structured child's terminal value threads back typed — summary_value, parent field access, event payload", async () => {
    await writeWorkflow(
      'child-structured',
      `
name: child-structured
description: terminal node emits a structured payload
nodes:
  - id: verdict
    prompt: PRODUCE the verdict
    output_format:
      type: object
      properties:
        green: { type: boolean }
        items: { type: array }
`
    );
    await writeWorkflow(
      'parent-structured',
      `
name: parent-structured
description: reads a typed field off the child result
nodes:
  - id: sub
    workflow: child-structured
  - id: consume
    prompt: g=[$sub.output.green]
    depends_on: [sub]
`
    );

    const store = new InMemoryStore();
    const { deps, prompts } = makeStructuredDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-structured'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-structured');
    expect(child?.metadata?.summary).toBe('{"green":true,"items":["a","b"]}');
    expect(child?.metadata?.summary_value).toEqual({ green: true, items: ['a', 'b'] });
    // Typed field access on the parent side.
    expect(prompts).toContain('g=[true]');
    // The parent's sub node persisted the logical value for its own cold resume.
    const parent = [...store.runs.values()].find(r => r.workflow_name === 'parent-structured');
    const subCompleted = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'sub'
    );
    expect(subCompleted?.data?.structured_output).toEqual({ green: true, items: ['a', 'b'] });
  });

  it('AC6: fan-out aggregates are logical arrays — structured children single-encoded, string children raw', async () => {
    await writeWorkflow(
      'fan-handler',
      `
name: fan-handler
description: handles one item
mutates_checkout: false
nodes:
  - id: work
    prompt: HANDLE $ARGUMENTS
`
    );
    await writeWorkflow(
      'fan-mixed-parent',
      `
name: fan-mixed-parent
description: mixed structured and plain children
nodes:
  - id: plan
    bash: |
      printf '%s' '["alpha","beta","plain"]'
  - id: work
    workflow: fan-handler
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      join: all_success
`
    );

    const store = new InMemoryStore();
    const { deps } = makeStructuredDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-mixed-parent'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const parent = [...store.runs.values()].find(r => r.workflow_name === 'fan-mixed-parent');
    const workCompleted = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'work'
    );
    // Single-encoded: object elements are objects, the string child stays the exact
    // raw string it always was (byte-identical to pre-#2637 for text children).
    const expected = [{ v: 'alpha' }, { v: 'beta' }, 'did:plain'];
    expect(JSON.parse(String(workCompleted?.data?.node_output))).toEqual(expected);
    expect(workCompleted?.data?.structured_output).toEqual(expected);
  });

  it('AC6: all_done represents a failed child as { archon_failed, error, status } beside logical elements', async () => {
    await writeWorkflow(
      'fan-handler',
      `
name: fan-handler
description: handles one item
mutates_checkout: false
nodes:
  - id: work
    prompt: HANDLE $ARGUMENTS
`
    );
    await writeWorkflow(
      'fan-partial-parent',
      `
name: fan-partial-parent
description: one child fails, aggregate keeps the rest
nodes:
  - id: plan
    bash: |
      printf '%s' '["alpha","bad"]'
  - id: work
    workflow: fan-handler
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      join: all_done
`
    );

    const store = new InMemoryStore();
    const { deps } = makeStructuredDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-partial-parent'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const parent = [...store.runs.values()].find(r => r.workflow_name === 'fan-partial-parent');
    const workCompleted = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'work'
    );
    const aggregate = JSON.parse(String(workCompleted?.data?.node_output)) as unknown[];
    expect(aggregate[0]).toEqual({ v: 'alpha' });
    expect(aggregate[1]).toMatchObject({ archon_failed: true, status: 'failed' });
  });

  it('AC6: the failure marker stays separable from a payload that carries error+status fields', async () => {
    // A structured child whose OWN schema emits top-level `error` and `status` —
    // the natural verifier shape — completes beside a failed sibling. Shape-based
    // discrimination ('error' in r && 'status' in r) misclassifies the payload;
    // the reserved `archon_failed: true` marker is the only sound check, and it
    // must be present on the failed slot and absent from the completed one.
    await writeWorkflow(
      'fan-verifier',
      `
name: fan-verifier
description: verifies one item
mutates_checkout: false
nodes:
  - id: work
    prompt: VERIFY $ARGUMENTS
`
    );
    await writeWorkflow(
      'fan-verify-parent',
      `
name: fan-verify-parent
description: verifier payloads beside a failed slot
nodes:
  - id: plan
    bash: |
      printf '%s' '["alpha","bad"]'
  - id: work
    workflow: fan-verifier
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      join: all_done
`
    );

    const store = new InMemoryStore();
    const { deps } = makeStructuredDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-verify-parent'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const parent = [...store.runs.values()].find(r => r.workflow_name === 'fan-verify-parent');
    const workCompleted = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'work'
    );
    const aggregate = JSON.parse(String(workCompleted?.data?.node_output)) as Array<
      Record<string, unknown>
    >;
    // The completed verifier's slot is its payload, unmarked.
    expect(aggregate[0]).toEqual({ error: 'none found', status: 'clean' });
    // The failed slot carries the reserved discriminator.
    expect(aggregate[1]).toMatchObject({ archon_failed: true, status: 'failed' });
    // The documented collector check separates them exactly.
    expect(aggregate.filter(r => r?.archon_failed === true)).toHaveLength(1);
  });

  it('AC6: a chained fan-out consumes the logical aggregate without double-decoding, and `as` carries the logical item', async () => {
    await writeWorkflow(
      'fan-handler',
      `
name: fan-handler
description: handles one item
mutates_checkout: false
nodes:
  - id: work
    prompt: HANDLE $ARGUMENTS
`
    );
    await writeWorkflow(
      'fan-collector',
      `
name: fan-collector
description: consumes one aggregate element
mutates_checkout: false
inputs:
  item: {}
nodes:
  - id: read
    bash: printf '%s' "got=$INPUTS_ITEM"
`
    );
    await writeWorkflow(
      'fan-chain-parent',
      `
name: fan-chain-parent
description: second fan-out over the first aggregate
nodes:
  - id: plan
    bash: |
      printf '%s' '["alpha","beta"]'
  - id: first
    workflow: fan-handler
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      join: all_success
  - id: second
    workflow: fan-collector
    depends_on: [first]
    fan_out:
      items: "$first.output"
      as: item
      join: all_success
`
    );

    const store = new InMemoryStore();
    const { deps } = makeStructuredDeps(store);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-chain-parent'),
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const collectors = [...store.runs.values()].filter(r => r.workflow_name === 'fan-collector');
    expect(collectors).toHaveLength(2);
    // The per-item `as` binding carries the LOGICAL object element.
    const byIndex = new Map(
      collectors.map(c => [(c.metadata as Record<string, unknown>).child_index as number, c])
    );
    expect(byIndex.get(0)?.metadata?.inputs_values).toEqual({ item: { v: 'alpha' } });
    // $ARGUMENTS still carries the canonical text form of the item.
    expect(byIndex.get(0)?.user_message).toBe('{"v":"alpha"}');
    // Env delivery: single-encoded JSON, parse once.
    const read0 = store.events.find(
      e =>
        e.workflow_run_id === byIndex.get(0)?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'read'
    );
    expect(String(read0?.data?.node_output)).toBe('got={"v":"alpha"}');
  });

  it('AC1+AC6: a parent cold resume rehydrates the logical fan-out aggregate', async () => {
    await writeWorkflow(
      'fan-handler',
      `
name: fan-handler
description: handles one item
mutates_checkout: false
nodes:
  - id: work
    prompt: HANDLE $ARGUMENTS
`
    );
    await writeWorkflow(
      'fan-resume-parent',
      `
name: fan-resume-parent
description: collector fails once, resume replays the aggregate
nodes:
  - id: plan
    bash: |
      printf '%s' '["alpha","beta"]'
  - id: work
    workflow: fan-handler
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      join: all_success
  - id: collect
    bash: |
      if [ -f "$STATE_DIR/collect-marker" ]; then printf 'agg=%s' $work.output; else touch "$STATE_DIR/collect-marker"; exit 1; fi
    depends_on: [work]
`
    );

    const store = new InMemoryStore();
    const { deps } = makeStructuredDeps(store);
    const first = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-resume-parent'),
      'goal',
      { conversationId: 'conv-db' }
    );
    expect(first.success).toBe(false);

    const parent = [...store.runs.values()].find(r => r.workflow_name === 'fan-resume-parent');
    expect(parent?.status).toBe('failed');
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parent!.id))!);
    expect(hydrated).not.toBeNull();
    // The snapshot rehydrated the fan-out node's LOGICAL aggregate, not just text.
    expect(hydrated?.priorCompletedNodes.get('work')?.structuredOutput).toEqual([
      { v: 'alpha' },
      { v: 'beta' },
    ]);

    const second = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-resume-parent'),
      'goal',
      { conversationId: 'conv-db' },
      { ...hydrated! }
    );
    expect(second.success).toBe(true);
    // The resumed collector read the identical single-encoded aggregate.
    const collectCompleted = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_completed' &&
        e.step_name === 'collect'
    );
    expect(String(collectCompleted?.data?.node_output)).toBe('agg=[{"v":"alpha"},{"v":"beta"}]');
    // And the fan-out node's replay row carried the logical value forward.
    const replayed = store.events.find(
      e =>
        e.workflow_run_id === parent?.id &&
        e.event_type === 'node_skipped_prior_success' &&
        e.step_name === 'work'
    );
    expect(replayed?.data?.structured_output).toEqual([{ v: 'alpha' }, { v: 'beta' }]);
  });
});
