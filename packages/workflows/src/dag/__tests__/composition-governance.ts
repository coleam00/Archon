import { providerRegistry } from '@archon/providers';
import { settlingProvider } from '../../test-settling-provider';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  composeScope,
  createMockDeps,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  minimalConfig,
  mockArtifactHome,
  mockClaudeCapabilities,
  mockCodexCapabilities,
  mockGetAgentProviderDag,
  mockSendQueryDag,
  ready,
  setMockArtifactHome,
} from '../test-utils';
import { executeDagWorkflow } from '../../dag-executor';
import type { ResolvedWorkflow, WorkflowDefinition } from '../../schemas';
import { dagNodeSchema } from '../../schemas';
import { discoverWorkflows } from '../../workflow-discovery';
import { expandWorkflowIncludes } from '../../include-expander';
import type { WorkflowDeps } from '../../deps';
import type { PersistedNodeOutput } from '../../store';

export function registerGovernanceTests() {
  // ---------------------------------------------------------------------------
  // Governance and resume across the config collapse (#1764 Task 11).
  //
  // These assert EXISTING behaviour that the collapse must not disturb. A failure here is
  // a finding about the change, not a licence to move the assertion.
  // ---------------------------------------------------------------------------

  describe('executeDagWorkflow -- composition governance survives the collapse', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `dag-gov-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

    it('AC13 — a run paused BEFORE the collapse resumes with collapsed config afterwards', async () => {
      // The snapshot is keyed by persisted `step_name`. The collapse rewrites node PAYLOADS,
      // never node IDS, so a map written by an older build still matches — and the nodes that
      // do re-run pick up the block's own provider rather than the parent's.
      const block = buildWf(
        'resume-blk',
        [
          { id: 'first', prompt: 'first' },
          { id: 'second', prompt: 'second', depends_on: ['first'] },
        ],
        { provider: 'codex', model: 'gpt-5.6-sol' }
      );
      const parent = buildWf('resume-parent', [{ id: 'inc', include: 'resume-blk' }], {
        provider: 'claude',
      });

      const { workflows, errors } = expandWorkflowIncludes(
        new Map([
          ['resume-blk', block],
          ['resume-parent', parent],
        ])
      );
      expect(errors).toEqual([]);

      // Written by a build that predates this change: bare namespaced ids, no payload.
      const prior = new Map([['inc__first', { output: 'FIRST OUTPUT' }]]);

      const store = createMockStore();
      const seen: string[] = [];
      const deps: WorkflowDeps = {
        providers: providerRegistry,
        store,
        getAgentProvider: mock<WorkflowDeps['getAgentProvider']>(
          (provider): ReturnType<WorkflowDeps['getAgentProvider']> => {
            seen.push(provider);
            return settlingProvider({
              sendQuery: mockSendQueryDag,
              checkCredential: async () => ({
                state: 'not_checked' as const,
                source: 'native' as const,
              }),
              getType: (): string => provider,
              getCapabilities:
                provider === 'codex' ? mockCodexCapabilities : mockClaudeCapabilities,
            });
          }
        ),
        loadConfig: mock<WorkflowDeps['loadConfig']>(async _cwd => minimalConfig),
      };

      await executeDagWorkflow(
        dagOptions({
          deps,
          conversationId: 'conv-gov',
          cwd: testDir,
          workflow: ready(workflows.get('resume-parent')!),
          workflowRun: makeWorkflowRun('gov-resume', { workflow_name: 'resume-parent' }),
          priorCompletedNodes: prior,
        })
      );

      const events = store.createWorkflowEvent.mock.calls.map(call => call[0]);
      expect(
        events.some(
          e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'inc__first'
        )
      ).toBe(true);
      expect(
        events.some(e => e.event_type === 'node_completed' && e.step_name === 'inc__second')
      ).toBe(true);
      // The one node that re-ran used the BLOCK's provider, not the parent's.
      expect(seen).toEqual(['codex']);
    });

    it('AC12 — a composed approval pauses the PARENT run, with no child run id', async () => {
      const block = buildWf('gate-blk', [
        { id: 'plan', prompt: 'plan' },
        {
          id: 'gate',
          approval: { message: 'Approve?', capture_response: false },
          depends_on: ['plan'],
        },
      ]);
      const parent = buildWf('gate-parent', [{ id: 'inc', include: 'gate-blk' }], {
        interactive: true,
      });

      const { workflows, errors } = expandWorkflowIncludes(
        new Map([
          ['gate-blk', block],
          ['gate-parent', parent],
        ])
      );
      expect(errors).toEqual([]);

      const store = createMockStore();
      const runId = 'gov-gate-run';
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-gov',
          cwd: testDir,
          workflow: ready(workflows.get('gate-parent')!),
          workflowRun: makeWorkflowRun(runId, { workflow_name: 'gate-parent' }),
        })
      );

      const pauseCalls = store.pauseWorkflowRun.mock.calls;
      expect(pauseCalls.length).toBe(1);
      // One addressable run: the composition pauses the run that composed it. A `workflow:`
      // node would instead pause a second row the human approves by its own id.
      expect(pauseCalls[0][0]).toBe(runId);
      const ctx = pauseCalls[0][1];
      expect(ctx).toMatchObject({ type: 'approval', nodeId: 'inc__gate' });
      expect('childRunId' in ctx).toBe(false);
      expect(store.createWorkflowRun).not.toHaveBeenCalled();
    });
  });
}

export function registerComposedResultTests() {
  // ---------------------------------------------------------------------------
  // #2453 — the composed proof. One run carries a result contract across every
  // surface the earlier phases delivered: a `script:` node certifies its own stdout,
  // the result points at a file instead of carrying it, an `include:` alias exposes
  // that contract to the parent, `fan_out.items` consumes one of its declared fields
  // as a real array, each instance certifies its own per-item result, and a cold
  // resume reproduces all of it. This is the executable twin of the reference fixture
  // `.archon/workflows/test-workflows/e2e-contract-fanout.yaml`.
  // ---------------------------------------------------------------------------

  describe('a result contract survives the whole composed path (#2453)', () => {
    let testDir: string;
    let outputRoot: string;
    let runArtifactsDir: string;
    const originalArtifactHome = mockArtifactHome;

    const RUN_ID = 'composed-contract-run';
    const UNITS = [
      { id: 'unit-a', title: 'first unit of work' },
      { id: 'unit-b', title: 'second unit of work' },
    ];
    const POINTER = { type: 'archon_artifact', run_id: RUN_ID, path: 'plan.md' };
    const PLAN_RESULT = { units: UNITS, plan: POINTER };
    // Each instance points at the per-item file it wrote. Instances run INSIDE this run,
    // so every pointer names this run — the only run a producer may name.
    const AGGREGATE = UNITS.map(unit => ({
      id: unit.id,
      ok: true,
      report: { type: 'archon_artifact', run_id: RUN_ID, path: `units/${unit.id}.md` },
    }));

    type PersistedEvent = {
      event_type: string;
      step_name?: string;
      data?: Record<string, unknown>;
    };

    beforeEach(async () => {
      testDir = join(
        tmpdir(),
        `dag-composed-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      outputRoot = join(testDir, 'workspaces', '_cwd', 'proj');
      runArtifactsDir = join(outputRoot, 'artifacts', 'runs', RUN_ID);
      await mkdir(join(testDir, '.archon', 'workflows'), { recursive: true });
      // The run's own artifacts directory, which the plan script writes into and its
      // pointer then names — the same directory the pointer gate resolves independently
      // from the run's persisted `output_root`.
      await mkdir(runArtifactsDir, { recursive: true });
      setMockArtifactHome(testDir);
      mockSendQueryDag.mockClear();
      mockGetAgentProviderDag.mockClear();
      mockGetAgentProviderDag.mockImplementation(() => ({
        sendQuery: mockSendQueryDag,
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      }));

      // The block whose `returns:` node certifies the workflow's result. A deterministic
      // producer (Phase 2) writing the large artifact and returning a small value that
      // points at it (Phase 4).
      await writeFile(
        join(testDir, '.archon', 'workflows', 'plan-block.yaml'),
        `
name: plan-block
description: certifies a result carrying a unit list and a pointer at the full plan
mutates_checkout: false
returns: build
nodes:
  - id: build
    runtime: bun
    script: |
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      writeFileSync(join(process.env.ARTIFACTS_DIR, 'plan.md'), '# the full plan');
      console.log(
        JSON.stringify({
          units: ${JSON.stringify(UNITS)},
          plan: { type: 'archon_artifact', run_id: process.env.WORKFLOW_ID, path: 'plan.md' },
        })
      );
    output_format:
      type: object
      properties:
        units:
          type: array
          items:
            type: object
            properties:
              id: { type: string }
              title: { type: string }
            required: [id, title]
        plan:
          type: object
          properties:
            type: { const: archon_artifact }
            run_id: { type: string }
            path: { type: string }
          required: [type, run_id, path]
      required: [units, plan]
`
      );

      // The per-item body. It owns its own contract, so the aggregate is an array of
      // validated objects rather than an array of prose — each pointing at a per-item file
      // the instance wrote, proved at that producer against the run it runs in.
      await writeFile(
        join(testDir, '.archon', 'workflows', 'unit-block.yaml'),
        `
name: unit-block
description: one instance per unit, certifying its own per-item result
mutates_checkout: false
inputs:
  unit:
    required: true
returns: check
nodes:
  - id: check
    runtime: bun
    script: |
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const unit = JSON.parse(process.env.INPUTS_UNIT);
      mkdirSync(join(process.env.ARTIFACTS_DIR, 'units'), { recursive: true });
      writeFileSync(join(process.env.ARTIFACTS_DIR, 'units', unit.id + '.md'), '# ' + unit.title);
      console.log(JSON.stringify({
        id: unit.id,
        ok: typeof unit.title === 'string',
        report: { type: 'archon_artifact', run_id: process.env.WORKFLOW_ID, path: 'units/' + unit.id + '.md' },
      }));
    output_format:
      type: object
      properties:
        id: { type: string }
        ok: { type: boolean }
        report:
          type: object
          properties:
            type: { const: archon_artifact }
            run_id: { type: string }
            path: { type: string }
          required: [type, run_id, path]
      required: [id, ok, report]
`
      );

      await writeFile(
        join(testDir, '.archon', 'workflows', 'composed-parent.yaml'),
        `
name: composed-parent
description: reads the included block's contract and fans a composed body out over it
mutates_checkout: false
nodes:
  - id: plan
    include: plan-block
  - id: work
    include: unit-block
    depends_on: [plan]
    fan_out:
      items: "$plan.output.units"
      as: unit
      max_parallel: 2
      join: all_success
  - id: report
    prompt: "aggregate=$work.output pointer=$plan.output.plan"
    depends_on: [work]
`
      );
    });

    afterEach(async () => {
      setMockArtifactHome(originalArtifactHome);
      await removeTempTree(testDir);
    });

    /** The flattened parent, exactly as discovery hands it to the executor. */
    async function expandedParent(): Promise<ResolvedWorkflow> {
      const discovered = await discoverWorkflows(testDir, {
        providers: providerRegistry,
        loadDefaults: false,
      });
      expect(discovered.errors).toEqual([]);
      const parent = discovered.workflows.find(w => w.workflow.name === 'composed-parent');
      if (!parent) throw new Error('composed-parent was not discovered');
      return parent.workflow;
    }

    async function runComposed(
      priorCompletedNodes?: Map<string, PersistedNodeOutput>
    ): Promise<{ events: PersistedEvent[]; prompts: string[] }> {
      const prompts: string[] = [];
      mockSendQueryDag.mockImplementation(async function* (prompt: string) {
        prompts.push(prompt);
        yield { type: 'agent_message_chunk', text: 'reported' };
        yield { type: 'result', sessionId: 'sid-report' };
      });
      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-2453-composed',
          cwd: testDir,
          workflow: await expandedParent(),
          workflowRun: makeWorkflowRun(RUN_ID, { output_root: outputRoot }),
          artifactsDir: runArtifactsDir,
          priorCompletedNodes,
        })
      );
      const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
        (call: unknown[]) => call[0] as PersistedEvent
      );
      return { events, prompts };
    }

    const completionOf = (events: PersistedEvent[], step: string): PersistedEvent | undefined =>
      events.find(e => e.event_type === 'node_completed' && e.step_name === step);

    it('certifies a script result, exposes it through an include alias, and fans out over a declared field', async () => {
      const { events, prompts } = await runComposed();

      // The alias resolved to the included block's selected node, which certified its
      // own stdout: canonical text plus the logical value, pointer intact.
      const plan = completionOf(events, 'plan__build');
      expect(plan?.data?.structured_output).toEqual(PLAN_RESULT);
      expect(String(plan?.data?.node_output)).toBe(JSON.stringify(PLAN_RESULT));

      // `fan_out.items` read the DECLARED `units` field as a real array — one instance
      // per element, each certifying its own result.
      const instances = events.filter(
        e =>
          e.event_type === 'node_completed' &&
          (e.step_name ?? '').startsWith(`${composeScope('work')}__`) &&
          (e.step_name ?? '').endsWith('__check')
      );
      expect(instances).toHaveLength(2);
      expect(instances.map(e => e.data?.structured_output)).toEqual(
        expect.arrayContaining(AGGREGATE)
      );

      // The wrapper aggregate is the ordered logical array, serialized exactly once, and
      // it relays each instance's pointer unrewritten: one per item, naming this run and
      // the relative path the instance wrote — a real file under this run's artifacts.
      const wrapper = completionOf(events, 'work');
      expect(wrapper?.data?.structured_output).toEqual(AGGREGATE);
      expect(JSON.parse(String(wrapper?.data?.node_output))).toEqual(AGGREGATE);
      for (const unit of UNITS) {
        expect(existsSync(join(runArtifactsDir, 'units', `${unit.id}.md`))).toBe(true);
      }

      // Downstream, the aggregate is one JSON array and the pointer is still a run id
      // plus a relative path — never expanded, never replaced by the file's contents.
      expect(prompts).toEqual([
        `aggregate=${JSON.stringify(AGGREGATE)} pointer=${JSON.stringify(POINTER)}`,
      ]);
    });

    it('reproduces the same downstream view after a cold resume', async () => {
      const fresh = await runComposed();
      const plan = completionOf(fresh.events, 'plan__build');

      // Only what an event row carries: the text and its logical sibling. Field
      // authorization is re-derived from the loaded block, which is what keeps
      // `$plan.output.units` a declared array rather than a lenient text parse.
      const resumed = await runComposed(
        new Map<string, PersistedNodeOutput>([
          [
            'plan__build',
            {
              output: String(plan?.data?.node_output),
              structuredOutput: plan?.data?.structured_output,
            },
          ],
        ])
      );

      expect(resumed.prompts).toEqual(fresh.prompts);
      expect(completionOf(resumed.events, 'work')?.data?.structured_output).toEqual(AGGREGATE);
      // The producer was not re-run; its contract rode the prior-success re-emit forward.
      expect(completionOf(resumed.events, 'plan__build')).toBeUndefined();
      const replayed = resumed.events.find(
        e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'plan__build'
      );
      expect(replayed?.data?.structured_output).toEqual(PLAN_RESULT);
    });

    it('rejects at load a fan-out that reads a field the contract never declared', async () => {
      await writeFile(
        join(testDir, '.archon', 'workflows', 'composed-parent.yaml'),
        `
name: composed-parent
description: fans out over a field the included block does not declare
mutates_checkout: false
nodes:
  - id: plan
    include: plan-block
  - id: work
    include: unit-block
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
      as: unit
      max_parallel: 2
      join: all_success
`
      );

      const discovered = await discoverWorkflows(testDir, {
        providers: providerRegistry,
        loadDefaults: false,
      });
      // The error names the include alias the author wrote, not the flattened sink id.
      expect(discovered.errors.map(e => e.error)).toEqual([
        expect.stringContaining("'$plan.output.tasks' references field 'tasks'"),
      ]);
      expect(discovered.errors[0]?.error).not.toContain('plan__build');
    });
  });
}
