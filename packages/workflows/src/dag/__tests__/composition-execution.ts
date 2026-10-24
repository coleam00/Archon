import { removeTempTree } from '@archon/paths/test-utils';
import type { SendQueryOptions } from '@archon/provider-contract';
import { providerRegistry } from '@archon/providers';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeDagWorkflow } from '../../dag-executor';
import type { WorkflowConfig, WorkflowDeps } from '../../deps';
import { expandWorkflowIncludes } from '../../include-expander';
import {
  buildAiProfile,
  isLiteralSpec,
  resolveModelSpec,
  selectModelRef,
  type ModelAliasPreset,
  type RawTiersConfig,
} from '../../model-validation';
import type { DagNode, LoopGroupNode, WorkflowDefinition } from '../../schemas';
import { dagNodeSchema } from '../../schemas';
import {
  createMockDeps,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  minimalConfig,
  mockClaudeCapabilities,
  mockCodexCapabilities,
  mockSendQueryDag,
  ready,
  type MockWorkflowStore,
  type TestWorkflowDefinition,
} from '../test-utils';

export function registerAuthoredConfigTests() {
  // ---------------------------------------------------------------------------
  // "A workflow runs as authored" (#1764) — the composition invariant, measured.
  //
  // A workflow's node-affecting configuration is collapsed onto its own nodes at
  // expansion and the workflow-level layer is removed, so a composed workflow resolves
  // exactly what it would resolve standalone. These tests observe the SAME seat every
  // other option test uses — the `sendQuery(prompt, cwd, resume, options)` call — and
  // compare a block run standalone against the same block run inside a parent that
  // declares different values.
  //
  // Two pass conditions per case, both required:
  //   INVARIANT       composed === standalone
  //   REGRESSION      raw standalone === collapsed standalone (nothing shipped moves)
  // The invariant alone would pass a collapse bug that shifted BOTH sides equally.
  // ---------------------------------------------------------------------------
  describe('executeDagWorkflow -- a workflow runs as authored, standalone or composed', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `dag-collapse-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await removeTempTree(testDir);
    });

    /** Per-node configuration as the provider actually received it. */
    interface EffectiveConfig {
      provider: string;
      model: unknown;
      effort: unknown;
      sandbox: unknown;
      betas: unknown;
      fallbackModel: unknown;
    }

    function wfDef(name: string, nodes: unknown[], workflowLevel: object = {}): WorkflowDefinition {
      // Each node is already parsed (flat -> resolved) below — do NOT also route the
      // whole object through workflowDefinitionSchema.parse(): its `nodes` field
      // re-validates against the FLAT authored schema, which an already-resolved
      // DagNode (kind/source) no longer satisfies (#2486).
      return {
        name,
        description: name,
        nodes: nodes.map(n => dagNodeSchema.parse(n)),
        ...workflowLevel,
      };
    }

    const collapseConfig: WorkflowConfig & { assistant: string } = {
      assistant: 'claude',
      assistants: { claude: { model: 'claude-default' }, codex: { model: 'codex-default' } },
      commands: {},
      defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
    };

    /**
     * Run one workflow and return each node's effective configuration, keyed by the node's
     * id with any include namespace stripped — so a block's `scope` node is comparable
     * whether it ran standalone or as `blk__scope`.
     *
     * The workflow-level provider/model/preset derivation mirrors executor.ts (the ~15
     * lines above its `executeDagWorkflow` call). Every variant is scored through the same
     * mirror, so a mirror error cancels out instead of biasing one side.
     */
    async function effectiveConfigs(
      defs: readonly WorkflowDefinition[],
      runName: string,
      options: { expand?: boolean; profileProvider?: string; tiers?: RawTiersConfig } = {}
    ): Promise<Map<string, EffectiveConfig>> {
      let workflow: TestWorkflowDefinition;
      if (options.expand === false) {
        workflow = defs.find(d => d.name === runName)!;
      } else {
        const { workflows, errors } = expandWorkflowIncludes(new Map(defs.map(d => [d.name, d])));
        expect(errors).toEqual([]);
        workflow = workflows.get(runName)!;
      }

      const aiProfile = buildAiProfile(options.profileProvider ?? collapseConfig.assistant, {
        ...(options.tiers ? { repoTiers: options.tiers } : {}),
      });

      // --- mirror of executor.ts's workflow-level resolution ---
      let workflowProvider: string = workflow.provider ?? collapseConfig.assistant;
      let workflowModel: string | undefined;
      let workflowPreset: ModelAliasPreset | undefined;
      if (workflow.model) {
        const spec = resolveModelSpec(aiProfile, selectModelRef(workflow.model, aiProfile));
        if (isLiteralSpec(spec)) {
          workflowModel = spec.literal;
        } else {
          workflowPreset = spec;
          workflowProvider = spec.provider;
          workflowModel = spec.model;
        }
      }
      workflowModel ??= collapseConfig.assistants[workflowProvider]?.model as string | undefined;
      // --- end mirror ---

      const seen: { provider: string; options: SendQueryOptions }[] = [];
      const deps: WorkflowDeps = {
        providers: providerRegistry,
        store: createMockStore(),
        getAgentProvider: mock<WorkflowDeps['getAgentProvider']>(
          (provider): ReturnType<WorkflowDeps['getAgentProvider']> => ({
            sendQuery: mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(
              async function* (_prompt, _cwd, _resume, queryOptions) {
                if (!queryOptions) throw new Error('Expected provider query options');
                seen.push({ provider, options: queryOptions });
                yield { type: 'agent_message_chunk', text: 'ok' };
                yield { type: 'result', sessionId: `sid-${String(seen.length)}` };
                yield { type: 'settled' };
              }
            ),
            checkCredential: async () => ({
              state: 'not_checked' as const,
              source: 'native' as const,
            }),
            getType: (): string => provider,
            getCapabilities: provider === 'codex' ? mockCodexCapabilities : mockClaudeCapabilities,
          })
        ),
        loadConfig: mock<WorkflowDeps['loadConfig']>(async _cwd => collapseConfig),
      };

      await executeDagWorkflow(
        dagOptions({
          deps,
          conversationId: 'conv-collapse',
          cwd: testDir,
          workflow: ready(workflow),
          workflowRun: makeWorkflowRun(`collapse-${runName}`, { workflow_name: runName }),
          workflowProvider,
          workflowModel,
          config: collapseConfig,
          aiProfile,
          workflowPreset,
        })
      );

      const result = new Map<string, EffectiveConfig>();
      for (const { provider, options: queryOptions } of seen) {
        const nodeConfig = queryOptions.nodeConfig;
        if (!nodeConfig) throw new Error('Expected workflow node configuration');
        const rawId = String(nodeConfig.nodeId);
        const id = rawId.includes('__') ? rawId.slice(rawId.lastIndexOf('__') + 2) : rawId;
        result.set(id, {
          provider,
          model: queryOptions.model,
          effort: nodeConfig.effort,
          sandbox: nodeConfig.sandbox,
          betas: nodeConfig.betas,
          fallbackModel: nodeConfig.fallbackModel,
        });
      }
      return result;
    }

    /** The block under test: one node that declares nothing, one that overrides provider. */
    function richBlock(): WorkflowDefinition {
      return wfDef(
        'blk',
        [
          { id: 'scope', prompt: 'scope it' },
          { id: 'impl', prompt: 'implement', depends_on: ['scope'], provider: 'claude' },
        ],
        {
          provider: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
          sandbox: { enabled: true },
          fallbackModel: 'gpt-5-mini',
        }
      );
    }

    it('AC1 — a configured block resolves identically composed and standalone', async () => {
      const block = richBlock();
      const parent = wfDef(
        'parent',
        [
          { id: 'setup', prompt: 'set up' },
          { id: 'review', include: 'blk', depends_on: ['setup'] },
        ],
        { provider: 'claude', model: 'claude-parent', effort: 'low' }
      );

      const standalone = await effectiveConfigs([block], 'blk');
      const composed = await effectiveConfigs([block, parent], 'parent');

      // INVARIANT: every node of the block resolved the same way in both runs.
      for (const id of ['scope', 'impl']) {
        expect(composed.get(id), `node '${id}' composed`).toEqual(standalone.get(id)!);
      }
      // The block really did declare something different from its parent — without this
      // the invariant could hold because everything collapsed to one provider.
      expect(standalone.get('scope')!.provider).toBe('codex');
      expect(standalone.get('scope')!.effort).toBe('high');
      // The parent's own node keeps the parent's configuration.
      expect(composed.get('setup')!.provider).toBe('claude');
      expect(composed.get('setup')!.effort).toBe('low');
    });

    it('REGRESSION — collapsing does not move a standalone run', async () => {
      const block = richBlock();
      const raw = await effectiveConfigs([block], 'blk', { expand: false });
      const collapsed = await effectiveConfigs([block], 'blk');
      expect(collapsed).toEqual(raw);
    });

    it('AC2 — a block declaring NOTHING resolves from config, not from the parent', async () => {
      // A bare include block, and the case naive push-down gets wrong: with
      // nothing of its own to push, the block's nodes would still inherit the parent's
      // workflow-level values unless that layer is REMOVED.
      const bare = wfDef('bare-blk', [{ id: 'work', prompt: 'work' }]);
      const parent = wfDef('parent', [{ id: 'inc', include: 'bare-blk' }], {
        provider: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      });

      const standalone = await effectiveConfigs([bare], 'bare-blk');
      const composed = await effectiveConfigs([bare, parent], 'parent');

      expect(composed.get('work')).toEqual(standalone.get('work')!);
      expect(composed.get('work')!.provider).toBe('claude'); // config.assistant
      expect(composed.get('work')!.model).toBe('claude-default');
      expect(composed.get('work')!.effort).toBeUndefined();
    });

    it('AC3 — three providers resolve independently in one run', async () => {
      const piBlock = wfDef('pi-blk', [{ id: 'run', prompt: 'pi work' }], { provider: 'pi' });
      const codexBlock = wfDef('codex-blk', [{ id: 'run', prompt: 'codex work' }], {
        provider: 'codex',
        model: 'gpt-5.6-sol',
      });
      const parent = wfDef(
        'parent',
        [
          { id: 'own', prompt: 'parent work' },
          { id: 'a', include: 'pi-blk', depends_on: ['own'] },
          { id: 'b', include: 'codex-blk', depends_on: ['a'] },
        ],
        { provider: 'claude' }
      );

      const { workflows, errors } = expandWorkflowIncludes(
        new Map([
          ['pi-blk', piBlock],
          ['codex-blk', codexBlock],
          ['parent', parent],
        ])
      );
      expect(errors).toEqual([]);
      const expanded = workflows.get('parent')!;
      const byId = new Map(expanded.nodes.map(n => [n.id, n as DagNode]));
      expect(byId.get('own')?.provider).toBe('claude');
      expect(byId.get('a__run')?.provider).toBe('pi');
      expect(byId.get('b__run')?.provider).toBe('codex');
      expect(byId.get('b__run')?.model).toBe('gpt-5.6-sol');
    });

    it('AC3 — a tier keyword reproduces through the collapse', async () => {
      const tiers = {
        large: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' as const },
      };
      const block = wfDef('tier-blk', [{ id: 'work', prompt: 'work' }], { model: 'large' });
      const parent = wfDef('parent', [{ id: 'inc', include: 'tier-blk' }], {
        provider: 'claude',
        model: 'claude-parent',
      });

      const standalone = await effectiveConfigs([block], 'tier-blk', { tiers });
      const composed = await effectiveConfigs([block, parent], 'parent', { tiers });

      expect(composed.get('work')).toEqual(standalone.get('work')!);
      // The tier resolved, rather than the raw keyword reaching the SDK.
      expect(standalone.get('work')!.provider).toBe('codex');
      expect(standalone.get('work')!.model).toBe('gpt-5.6-sol');
      expect(standalone.get('work')!.effort).toBe('xhigh');
    });

    it('AC1 — the collapse reaches loop_group bodies and depth-2 nesting', async () => {
      const inner = wfDef(
        'inner',
        [
          {
            id: 'group',
            loop_group: {
              until: 'DONE',
              max_iterations: 1,
              nodes: [{ id: 'body', prompt: 'body work' }],
            },
          },
        ],
        { provider: 'codex', model: 'gpt-5.6-sol' }
      );
      const mid = wfDef('mid', [{ id: 'in', include: 'inner' }], { provider: 'pi' });
      const top = wfDef('top', [{ id: 'm', include: 'mid' }], { provider: 'claude' });

      const { workflows, errors } = expandWorkflowIncludes(
        new Map([
          ['inner', inner],
          ['mid', mid],
          ['top', top],
        ])
      );
      expect(errors).toEqual([]);
      const group = workflows
        .get('top')!
        .nodes.find(n => n.id === 'm__in__group')! as LoopGroupNode;
      expect(group.provider).toBe('codex');
      // The body node carries the INNER file's provider, not mid's or top's.
      const body = group.loop_group?.nodes[0] as DagNode | undefined;
      expect(body?.provider).toBe('codex');
      expect(body?.model).toBe('gpt-5.6-sol');
    });
  });
}

export function registerRuntimeBoundariesTests() {
  // ---------------------------------------------------------------------------
  // Composition boundaries at run time (#1764):
  //   - a composed workflow's entry node starts a session as coldly as it would standalone
  //   - a composed workflow's declared inputs reach its shell nodes, named script included
  // ---------------------------------------------------------------------------

  describe('executeDagWorkflow -- composed-workflow run-time boundaries', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `dag-comp-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(testDir, { recursive: true });
      mockSendQueryDag.mockClear();
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'response' };
        yield { type: 'result', sessionId: 'session-1' };
      });
    });

    afterEach(async () => {
      await removeTempTree(testDir);
    });

    function buildWf(name: string, nodes: unknown[], extra: object = {}): WorkflowDefinition {
      // Each node is already parsed (flat -> resolved) below — do NOT also route the
      // whole object through workflowDefinitionSchema.parse(): its `nodes` field
      // re-validates against the FLAT authored schema, which an already-resolved
      // DagNode (kind/source) no longer satisfies (#2486).
      return {
        name,
        description: name,
        nodes: nodes.map(n => dagNodeSchema.parse(n)),
        ...extra,
      };
    }

    /** The `node_output` a completed node persisted, read from its node_completed event. */
    function nodeOutputOf(store: MockWorkflowStore, stepName: string): string | undefined {
      const event = store.createWorkflowEvent.mock.calls
        .map(c => c[0])
        .find(e => e.event_type === 'node_completed' && e.step_name === stepName);
      return (event?.data as { node_output?: string } | undefined)?.node_output;
    }

    async function runExpanded(
      defs: readonly WorkflowDefinition[],
      runName: string,
      deps = createMockDeps()
    ): Promise<void> {
      const { workflows, errors } = expandWorkflowIncludes(new Map(defs.map(d => [d.name, d])));
      expect(errors).toEqual([]);
      await executeDagWorkflow(
        dagOptions({
          deps,
          cwd: testDir,
          workflow: ready(workflows.get(runName)!),
          workflowRun: makeWorkflowRun(`comp-${runName}`, { workflow_name: runName }),
        })
      );
    }

    for (const kind of ['loop', 'loop_group'] as const) {
      for (const composed of [false, true]) {
        it(`#4164: ${kind}.until_bash receives ${composed ? 'composed' : 'run'} inputs`, async () => {
          const predicate = `[ "$INPUTS_TARGET" = "done" ] && [ "$INPUTS_PAYLOAD" = '$(touch injected); "quoted"' ] && [ "$ARGUMENTS" = "real-args" ]`;
          const block = buildWf(
            'input-loop',
            [
              kind === 'loop'
                ? { id: 'poll', loop: { prompt: 'work', until_bash: predicate, max_iterations: 2 } }
                : {
                    id: 'poll',
                    loop_group: {
                      until_bash: predicate,
                      max_iterations: 2,
                      nodes: [{ id: 'work', prompt: 'work' }],
                    },
                  },
            ],
            { inputs: { target: { required: true }, payload: { required: true } } }
          );
          const parent = buildWf('input-parent', [
            {
              id: 'inc',
              include: 'input-loop',
              with: { target: 'done', payload: '$(touch injected); "quoted"' },
            },
          ]);
          const { workflows, errors } = expandWorkflowIncludes(
            new Map([
              ['input-loop', block],
              ['input-parent', parent],
            ])
          );
          expect(errors).toEqual([]);
          const store = createMockStore();
          await executeDagWorkflow(
            dagOptions({
              deps: createMockDeps(store),
              cwd: testDir,
              workflow: ready(composed ? workflows.get('input-parent')! : block),
              workflowRun: makeWorkflowRun('input-loop-run', {
                user_message: 'real-args',
                metadata: {
                  inputs: {
                    target: composed ? 'wrong-run-value' : 'done',
                    payload: '$(touch injected); "quoted"',
                  },
                },
              }),
              config: {
                ...minimalConfig,
                envVars: { INPUTS_TARGET: 'wrong-project-value', ARGUMENTS: 'hijacked' },
              },
            })
          );
          expect(mockSendQueryDag.mock.calls.length).toBe(1);
          expect(store.completeWorkflowRun.mock.calls.length).toBe(1);
          expect(await Bun.file(join(testDir, 'injected')).exists()).toBe(false);
        });
      }
    }

    it("#4164: an included shell's $INPUTS macro reads the input as data", async () => {
      const payload = '$(touch injected); "quoted"';
      const block = buildWf(
        'macro-blk',
        [
          { id: 'echo', bash: "printf '%s' $INPUTS.payload" },
          {
            id: 'poll',
            depends_on: ['echo'],
            loop: { prompt: 'work', until_bash: '[ $INPUTS.target = done ]', max_iterations: 2 },
          },
        ],
        { inputs: { target: { required: true }, payload: { required: true } } }
      );
      const parent = buildWf('macro-parent', [
        { id: 'inc', include: 'macro-blk', with: { target: 'done', payload } },
      ]);
      const store = createMockStore();

      await runExpanded([block, parent], 'macro-parent', createMockDeps(store));

      expect(nodeOutputOf(store, 'inc__echo')).toBe(payload);
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      expect(store.completeWorkflowRun.mock.calls.length).toBe(1);
      expect(await Bun.file(join(testDir, 'injected')).exists()).toBe(false);
    });

    it("a script node's own with: binding beats a colliding composed and run input", async () => {
      const block = buildWf(
        'collide-blk',
        [
          {
            id: 'emit',
            runtime: 'bun',
            script: 'console.log(process.env.INPUTS_TARGET);',
            with: { target: 'local' },
          },
        ],
        { inputs: { target: { required: true } } }
      );
      const parent = buildWf('collide-parent', [
        { id: 'inc', include: 'collide-blk', with: { target: 'composed' } },
      ]);
      const { workflows, errors } = expandWorkflowIncludes(
        new Map([
          ['collide-blk', block],
          ['collide-parent', parent],
        ])
      );
      expect(errors).toEqual([]);
      const store = createMockStore();

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: ready(workflows.get('collide-parent')!),
          workflowRun: makeWorkflowRun('collide-run', { metadata: { inputs: { target: 'run' } } }),
        })
      );

      expect(nodeOutputOf(store, 'inc__emit')).toBe('local');
    });

    it('AC7 — a composed block entry starts a fresh session even after a same-provider node', async () => {
      const block = buildWf('sess-blk', [
        { id: 'first', prompt: 'block first' },
        { id: 'second', prompt: 'block second', depends_on: ['first'] },
      ]);
      const parent = buildWf('sess-parent', [
        { id: 'lead', prompt: 'parent lead' },
        { id: 'inc', include: 'sess-blk', depends_on: ['lead'] },
      ]);

      await runExpanded([block, parent], 'sess-parent');

      expect(mockSendQueryDag.mock.calls.length).toBe(3);
      // lead: nothing before it.
      expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
      // inc__first: the block's entry — cold, exactly as it would be standalone, even
      // though `lead` just produced a resumable session on the same provider.
      expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
      // inc__second: inside the block, so the block's own thread continues.
      expect(mockSendQueryDag.mock.calls[2][2]).toBe('session-1');
    });

    it("AC7 — context: 'shared' on the entry node opts back into the parent's thread", async () => {
      const block = buildWf('sess-blk2', [
        { id: 'first', prompt: 'block first', context: 'shared' },
      ]);
      const parent = buildWf('sess-parent2', [
        { id: 'lead', prompt: 'parent lead' },
        { id: 'inc', include: 'sess-blk2', depends_on: ['lead'] },
      ]);

      await runExpanded([block, parent], 'sess-parent2');

      expect(mockSendQueryDag.mock.calls[1][2]).toBe('session-1');
    });

    it("AC8 — a composed block's declared inputs reach a NAMED script as INPUTS_* env vars", async () => {
      // The acceptance case the task exists for: a named script file is opaque, so the
      // load-time `$INPUTS` macro can never reach inside it. Env delivery is its only channel.
      const scriptsDir = join(testDir, '.archon', 'scripts');
      await mkdir(scriptsDir, { recursive: true });
      await writeFile(
        join(scriptsDir, 'report.ts'),
        'console.log(`plan=${process.env.INPUTS_PLAN}|base=${process.env.INPUTS_BASE_BRANCH}`);\n'
      );

      const block = buildWf('script-blk', [{ id: 'run', script: 'report', runtime: 'bun' }], {
        inputs: { plan: { required: true }, 'base-branch': { default: 'dev' } },
      });
      const parent = buildWf('script-parent', [
        { id: 'inc', include: 'script-blk', with: { plan: 'ship it' } },
      ]);

      const store = createMockStore();
      await runExpanded([block, parent], 'script-parent', createMockDeps(store));

      const output = nodeOutputOf(store, 'inc__run');
      // A hyphenated input name arrives UPPER_SNAKE; the default fills the unsupplied one.
      expect(output).toBe('plan=ship it|base=dev');
    });

    it('AC8 — the stamp survives two nesting levels and keeps the INNER names', async () => {
      const inner = buildWf('inner-blk', [{ id: 'run', bash: 'echo "[$INPUTS_PLAN]"' }], {
        inputs: { plan: { required: true } },
      });
      const mid = buildWf(
        'mid-blk',
        [{ id: 'in', include: 'inner-blk', with: { plan: '$INPUTS.topic' } }],
        {
          inputs: { topic: { required: true } },
        }
      );
      const top = buildWf('nest-parent', [
        { id: 'm', include: 'mid-blk', with: { topic: 'two levels' } },
      ]);

      const store = createMockStore();
      await runExpanded([inner, mid, top], 'nest-parent', createMockDeps(store));

      const output = nodeOutputOf(store, 'm__in__run');
      expect(output).toBe('[two levels]');
    });

    it('AC8 — a composed input value resolving a node ref is delivered, not shell-spliced', async () => {
      const block = buildWf('ref-blk', [{ id: 'run', bash: 'echo "<$INPUTS_PAYLOAD>"' }], {
        inputs: { payload: { required: true } },
      });
      const parent = buildWf('ref-parent', [
        { id: 'produce', bash: 'printf "%s" "a b; echo pwned"' },
        {
          id: 'inc',
          include: 'ref-blk',
          depends_on: ['produce'],
          with: { payload: '$produce.output' },
        },
      ]);

      const store = createMockStore();
      await runExpanded([block, parent], 'ref-parent', createMockDeps(store));

      const output = nodeOutputOf(store, 'inc__run');
      // Delivered verbatim through the env bag — the `;` never reaches the shell as syntax.
      expect(output).toBe('<a b; echo pwned>');
    });

    it('AC8 — a project env var cannot shadow a composed input, and reserved keys still win', async () => {
      const block = buildWf('env-blk', [{ id: 'run', bash: 'echo "$INPUTS_PLAN|$ARGUMENTS"' }], {
        inputs: { plan: { required: true } },
      });
      const parent = buildWf('env-parent', [
        { id: 'inc', include: 'env-blk', with: { plan: 'from-with' } },
      ]);

      const store = createMockStore();
      const deps = createMockDeps(store);
      deps.loadConfig = mock<WorkflowDeps['loadConfig']>(async _cwd => ({
        ...minimalConfig,
        envVars: { INPUTS_PLAN: 'from-project-env', ARGUMENTS: 'hijacked' },
      }));

      const { workflows, errors } = expandWorkflowIncludes(
        new Map([
          ['env-blk', block],
          ['env-parent', parent],
        ])
      );
      expect(errors).toEqual([]);
      await executeDagWorkflow(
        dagOptions({
          deps,
          cwd: testDir,
          workflow: ready(workflows.get('env-parent')!),
          workflowRun: makeWorkflowRun('comp-env', {
            workflow_name: 'env-parent',
            user_message: 'real-args',
          }),
          config: {
            ...minimalConfig,
            envVars: { INPUTS_PLAN: 'from-project-env', ARGUMENTS: 'hijacked' },
          },
        })
      );

      const output = nodeOutputOf(store, 'inc__run');
      expect(output).toBe('from-with|real-args');
    });

    it('AC8 — the load-time macro still substitutes $INPUTS into an inline bash body', async () => {
      const block = buildWf('macro-blk', [{ id: 'run', bash: 'echo "$INPUTS.plan"' }], {
        inputs: { plan: { required: true } },
      });
      const parent = buildWf('macro-parent', [
        { id: 'inc', include: 'macro-blk', with: { plan: 'inline-value' } },
      ]);

      const store = createMockStore();
      await runExpanded([block, parent], 'macro-parent', createMockDeps(store));

      const output = nodeOutputOf(store, 'inc__run');
      expect(output).toBe('inline-value');
    });
  });
}
