// @archon-test-isolated
import { makeDeps, makePlatform } from './child-runs/test-utils';
import { holdsPathLock, InMemoryStore } from './child-runs/test-store';
import { providerRegistry } from '@archon/providers';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeWorkflow } from './executor';
import { discoverWorkflows } from './workflow-discovery';
import { validateWorkflowResources } from './validator';
import type { IWorkflowStore } from './store';
import type { ResolvedWorkflow } from './schemas/workflow';

// ===========================================================================
// LATE-RESOLUTION AFFORDANCE + RUNTIME-AUTHORED SUB-RUNS
// ---------------------------------------------------------------------------
// These lock a property that looks like an inconsistency and is not:
//
//   `include:` resolves its target at LOAD time (include-expander, at discovery).
//   `workflow:` resolves its target at SPAWN time (runChildWorkflow → discover).
//
// A tidy-up PR that "fixes" the asymmetry by adding a load-time existence check
// to `workflow:` would compile, pass every other test in this file, and silently
// destroy the only mechanism by which a run can author and execute its own
// children. That mechanism is the substrate for agent-authored ("god mode")
// workflows: the agent's decisions land as real YAML, run as real governed child
// runs, and stay promotable into the deterministic lane.
//
// Late resolution is therefore a DELIBERATE CONSTITUTIONAL AFFORDANCE, not an
// oversight. If you are here because one of these tests failed, the question to
// answer before changing them is: "does agent-authored sub-run composition still
// work?" — not "should validation be stricter?".
//
// See: .archon/workflow-language-constitution.md
// ===========================================================================
describe('workflow: late resolution is a deliberate affordance', () => {
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

  /** A child workflow whose single bash node echoes a caller-supplied marker. */
  function slotYaml(name: string, marker: string): string {
    return `
name: ${name}
description: runtime-authored slot
nodes:
  - id: emit
    bash: echo "${marker} input=$ARGUMENTS"
`;
  }

  beforeEach(async () => {
    cwd = join(tmpdir(), `lateres-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');
  });

  // `ARCHON_HOME` points inside `cwd`, so this hook removes the staged captures a run
  // still holds open when a test times out. A raw recursive `rm` gives up the moment
  // Windows answers EPERM/EBUSY for one of those handles; `removeTempTree` retries until
  // they close, and reports rather than throwing if they never do (#2924).
  afterEach(async () => {
    await removeTempTree(cwd);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  // --- Group 1: load-time must stay permissive -----------------------------

  it('LOCK: discovery ACCEPTS a workflow: node whose target does not exist', async () => {
    // If this ever fails, someone added a load-time existence check. That check
    // makes runtime-authored children impossible — the slot does not exist yet
    // when the parent is loaded, by construction.
    await writeWorkflow(
      'parent-forward-ref',
      `
name: parent-forward-ref
description: references a slot that will only exist at spawn time
nodes:
  - id: sub
    workflow: not-yet-authored
`
    );

    const result = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(result.errors).toHaveLength(0);
    expect(result.workflows.map(w => w.workflow.name)).toContain('parent-forward-ref');
  });

  it('LOCK: validateWorkflowResources does NOT flag an unresolvable sub-run target', async () => {
    // `archon validate workflows` goes through this. It must stay quiet about
    // sub-run targets — a forward reference is legal by design. (Contrast
    // `include:`, whose target IS resolved at load and DOES error when missing.)
    await writeWorkflow(
      'parent-forward-ref',
      `
name: parent-forward-ref
description: references a slot that will only exist at spawn time
nodes:
  - id: sub
    workflow: not-yet-authored
`
    );

    const wf = await discover('parent-forward-ref');
    const issues = await validateWorkflowResources(wf, cwd, providerRegistry);
    const errors = issues.filter(i => i.level === 'error');
    expect(errors).toHaveLength(0);
  });

  // --- Group 2: the generate-and-run mechanism -----------------------------

  it('a run authors a child mid-flight and a later workflow: node executes it', async () => {
    // The core god-mode primitive. `author` writes the slot; `sub` resolves it at
    // spawn time. Neither the slot file nor its name existed when the parent was
    // loaded.
    await writeWorkflow(
      'parent-authors-child',
      `
name: parent-authors-child
description: authors its own child, then runs it
nodes:
  - id: author
    bash: |
      cat > "${join(cwd, '.archon', 'workflows')}/authored-slot.yaml" <<'YAML'
      name: authored-slot
      description: written at runtime
      nodes:
        - id: emit
          bash: echo "AUTHORED_AT_RUNTIME input=$ARGUMENTS"
      YAML
      echo wrote
  - id: sub
    workflow: authored-slot
    input: from-parent
    depends_on: [author]
`
    );

    const store = new InMemoryStore();
    const parent = await discover('parent-authors-child');
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);

    const parentRun = [...store.runs.values()].find(
      r => r.workflow_name === 'parent-authors-child'
    );
    const children = [...store.runs.values()].filter(r => r.parent_run_id === parentRun?.id);
    expect(children).toHaveLength(1);
    expect(children[0]?.workflow_name).toBe('authored-slot');
    expect(children[0]?.status).toBe('completed');
    // The child received the parent's `input` as its user message...
    expect(children[0]?.user_message).toBe('from-parent');
    // ...and its output threaded back through the node.
    const done = store.events.find(e => e.event_type === 'node_completed' && e.step_name === 'sub');
    expect(String(done?.data?.node_output)).toContain('AUTHORED_AT_RUNTIME');
    expect(String(done?.data?.node_output)).toContain('from-parent');
  });

  it('LOCK: sub-run discovery is NOT cached across spawns in one run', async () => {
    // Caching discovery would be a defensible performance change and would break
    // re-authoring: the second spawn would replay the first body. Two sibling
    // nodes target the SAME name with the slot rewritten in between.
    await writeWorkflow('reused-slot', slotYaml('reused-slot', 'VERSION_ONE'));
    await writeWorkflow(
      'parent-reauthors',
      `
name: parent-reauthors
description: re-authors one slot between two sibling sub-runs
nodes:
  - id: pass-one
    workflow: reused-slot
    input: first
  - id: rewrite
    bash: |
      cat > "${join(cwd, '.archon', 'workflows')}/reused-slot.yaml" <<'YAML'
      name: reused-slot
      description: rewritten
      nodes:
        - id: emit
          bash: echo "VERSION_TWO input=$ARGUMENTS"
      YAML
      echo rewrote
    depends_on: [pass-one]
  - id: pass-two
    workflow: reused-slot
    input: second
    depends_on: [rewrite]
`
    );

    const store = new InMemoryStore();
    const parent = await discover('parent-reauthors');
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);

    const one = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'pass-one'
    );
    const two = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'pass-two'
    );
    expect(String(one?.data?.node_output)).toContain('VERSION_ONE');
    expect(String(two?.data?.node_output)).toContain('VERSION_TWO');
  });

  // --- Group 3: iteration by unrolling -------------------------------------

  it('LOCK: repeated SIBLING sub-runs of one name are not a cycle (unrolled iteration)', async () => {
    // The cycle guard walks ANCESTRY. Two sequential children of the same parent
    // are siblings, not ancestors — so a driver can run the same slot N times.
    // Tightening the guard to "name seen anywhere in the run tree" would make
    // unrolled iteration impossible. Complements the ancestry-cycle tests above,
    // which must keep passing.
    await writeWorkflow('loop-slot', slotYaml('loop-slot', 'PASS'));
    await writeWorkflow(
      'parent-unrolled',
      `
name: parent-unrolled
description: three sequential sub-runs of the same slot
nodes:
  - id: p1
    workflow: loop-slot
    input: one
  - id: p2
    workflow: loop-slot
    input: two
    depends_on: [p1]
  - id: p3
    workflow: loop-slot
    input: three
    depends_on: [p2]
`
    );

    const store = new InMemoryStore();
    const parent = await discover('parent-unrolled');
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-unrolled');
    const children = [...store.runs.values()].filter(r => r.parent_run_id === parentRun?.id);
    expect(children).toHaveLength(3);
    expect(children.every(c => c.status === 'completed')).toBe(true);
    // Each pass got its own input — they are distinct runs, not a replayed one.
    expect(children.map(c => c.user_message).sort()).toEqual(['one', 'three', 'two']);
  });

  it('when: on a later pass short-circuits the unrolled loop (early termination)', async () => {
    // Early exit is what makes an unrolled loop a LOOP rather than a fixed chain:
    // a bash node decides, and `when:` skips the remaining passes.
    await writeWorkflow('exit-slot', slotYaml('exit-slot', 'RAN'));
    await writeWorkflow(
      'parent-earlyexit',
      `
name: parent-earlyexit
description: stops after pass one when the check says DONE
nodes:
  - id: p1
    workflow: exit-slot
    input: one
  - id: check
    bash: echo DONE
    depends_on: [p1]
  - id: p2
    workflow: exit-slot
    input: two
    when: "$check.output != 'DONE'"
    depends_on: [check]
`
    );

    const store = new InMemoryStore();
    const parent = await discover('parent-earlyexit');
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-earlyexit');
    const children = [...store.runs.values()].filter(r => r.parent_run_id === parentRun?.id);
    // Exactly one child: the skipped pass must not spawn a run.
    expect(children).toHaveLength(1);
    expect(children[0]?.user_message).toBe('one');
  });

  // --- Group 4: known gaps, characterized so a fix fails loudly ------------

  it('GAP (#2200): a runtime-authored slot leaks into project-wide discovery', async () => {
    // A workflow authored for ONE run lands in the repo-scoped source tree, so it
    // becomes globally visible: `workflow list` shows it and the chat router can
    // match it. It is also NOT gitignored, so it is stageable into the user's repo
    // — the exact output-in-repo class #2200 exists to eliminate.
    //
    // The fix is a run-scoped fourth discovery tier (bundled < home < repo < run),
    // visible only to the spawning run's sub-run resolution. When that lands, this
    // assertion must flip to expect the slot to be ABSENT from plain discovery.
    await writeWorkflow('leaky-slot', slotYaml('leaky-slot', 'LEAK'));

    const result = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(result.workflows.map(w => w.workflow.name)).toContain('leaky-slot');
  });

  // The rendezvous wait runs inside executeWorkflow's lock guard, so it counts
  // fully against this test's clock: the timeout must exceed the rendezvous
  // deadline (5s) or a loaded CI run dies as a bun-test timeout instead of the
  // diagnostic rendezvous error.
  it(
    'children of different workflow nodes still compete for the shared checkout',
    async () => {
      const childYaml = (name: string, extra: string): string => `
name: ${name}
description: fan-out child
${extra}nodes:
  - id: emit
    bash: echo ok
`;
      const parentYaml = (child: string): string => `
name: parent-fanout-${child}
description: two ${child} children in one layer
nodes:
  - id: a
    workflow: ${child}
    input: a
  - id: b
    workflow: ${child}
    input: b
`;
      await writeWorkflow('racy-child', childYaml('racy-child', ''));
      await writeWorkflow('safe-child', childYaml('safe-child', 'mutates_checkout: false\n'));
      await writeWorkflow('parent-fanout-racy-child', parentYaml('racy-child'));
      await writeWorkflow('parent-fanout-safe-child', parentYaml('safe-child'));

      const kids = (store: InMemoryStore, name: string): string[] => {
        const parentRun = [...store.runs.values()].find(r => r.workflow_name === name);
        return [...store.runs.values()]
          .filter(r => r.parent_run_id === parentRun?.id)
          .map(r => r.status)
          .sort();
      };

      // Default posture: the sibling is cancelled and the parent run fails.
      // Whether the collision fires depends on both child rows coexisting in
      // non-terminal state when either lock query runs; under CI load the children
      // can serialize end-to-end and both succeed. This store holds each child's
      // lock query until BOTH child rows exist and are live, so the overlap the test
      // characterizes is a precondition instead of a chance interleaving.
      class RendezvousStore extends InMemoryStore {
        private overlapSeen = false;
        getActiveWorkflowRunByPath: IWorkflowStore['getActiveWorkflowRunByPath'] = async (
          path,
          self
        ) => {
          const selfRow = self ? this.runs.get(self.id) : undefined;
          if (!selfRow?.parent_run_id || this.overlapSeen) {
            return super.getActiveWorkflowRunByPath(path, self);
          }
          const parent = this.runs.get(selfRow.parent_run_id);
          if (!parent) return super.getActiveWorkflowRunByPath(path, self);
          const deadline = Date.now() + 5000;
          for (;;) {
            const children = await this.findChildRuns(parent.id);
            const live = children.filter(c => holdsPathLock(c.status));
            if (live.length >= 2) {
              this.overlapSeen = true;
            }
            if (this.overlapSeen) break;
            if (Date.now() > deadline) {
              throw new Error(
                `rendezvous failed: ${children.length} child rows, ${live.length} live`
              );
            }
            await new Promise(resolve => setTimeout(resolve, 1));
          }
          return super.getActiveWorkflowRunByPath(path, self);
        };
      }
      const racyStore = new RendezvousStore();
      const racyResult = await executeWorkflow(
        makeDeps(racyStore),
        makePlatform(),
        'conv-plat',
        cwd,
        await discover('parent-fanout-racy-child'),
        'goal',
        { conversationId: 'conv-db' }
      );
      expect(racyResult.success).toBe(false);
      expect(kids(racyStore, 'parent-fanout-racy-child')).toEqual(['cancelled', 'completed']);

      // With mutates_checkout:false the lock is skipped and both children run.
      const safeStore = new InMemoryStore();
      const safeResult = await executeWorkflow(
        makeDeps(safeStore),
        makePlatform(),
        'conv-plat',
        cwd,
        await discover('parent-fanout-safe-child'),
        'goal',
        { conversationId: 'conv-db' }
      );
      expect(safeResult.success).toBe(true);
      expect(kids(safeStore, 'parent-fanout-safe-child')).toEqual(['completed', 'completed']);
    },
    testTimeout(20000)
  );

  it('GAP (#2180 Defect A): a GATING child loses the path lock before it ever reaches its gate', async () => {
    // Fan-out where both children would gate. What actually happens is the PATH LOCK
    // (Defect A), not the gate-slot collision: the losing child is cancelled before it
    // ever reaches its `approval:` node, so `pauseParentOnChild` never runs for it.
    //
    await writeWorkflow(
      'gating-child',
      `
name: gating-child
description: pauses at a gate
nodes:
  - id: gate
    approval:
      message: needs review
`
    );
    await writeWorkflow(
      'parent-fanout-gates',
      `
name: parent-fanout-gates
description: two gating children in the same layer
nodes:
  - id: a
    workflow: gating-child
    input: a
  - id: b
    workflow: gating-child
    input: b
`
    );

    const store = new InMemoryStore();
    const parent = await discover('parent-fanout-gates');
    await executeWorkflow(makeDeps(store), makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-fanout-gates');
    const children = [...store.runs.values()].filter(r => r.parent_run_id === parentRun?.id);
    // Both children are created, but only ONE survives. The issue body described the
    // loser as "real but unmentioned"; in fact it loses the PATH LOCK and is CANCELLED
    // before reaching its gate — and because the cancellation surfaces through
    // `pauseParentOnChild`'s node, a node_failed IS emitted. That event is Defect A's
    // ("was cancelled"), NOT evidence about the gate slot.
    expect(children).toHaveLength(2);
    expect(children.map(c => c.status).sort()).toEqual(['cancelled', 'paused']);
    const loserFailed = store.events.find(
      e => e.event_type === 'node_failed' && String(e.data?.error).includes('was cancelled')
    );
    expect(loserFailed).toBeDefined();
    // The parent records exactly one block reason — the surviving paused child.
    const approval = (parentRun?.metadata as Record<string, unknown> | undefined)?.approval as
      | Record<string, unknown>
      | undefined;
    expect(approval).toBeDefined();
    const paused = children.find(c => c.status === 'paused');
    expect(String(approval?.childRunId ?? '')).toBe(paused?.id ?? '');
  });
});
