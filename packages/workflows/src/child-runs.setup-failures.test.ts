// @archon-test-isolated
import { makeDeps, makePlatform, setForceRenameFailure } from './child-runs/test-utils';
import { InMemoryStore } from './child-runs/test-store';
import { providerRegistry } from '@archon/providers';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, readdir } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeWorkflow } from './executor';
import { discoverWorkflows } from './workflow-discovery';
import type { ResolvedWorkflow } from './schemas/workflow';

/** A child's setup fails after its source was staged or while it records its status. */
/**
 * Regression for the recursive `workflow:` sub-run path inside runChildWorkflow
 * (review R1). The wrap the new `capturedSourceOwner` field introduced in
 * #2690 only fires when the field is wired on the child opts. The top-level
 * entry points do; the recursive call from runChildWorkflow did not, so a
 * rename failure inside the child re-leaked the staged capture that the
 * field's docblock says the wrap's `finally` reclaims.
 *
 * The forced rename is what makes this a real regression test: without the
 * wrap, the staged directory under ARCHON_HOME/staged-source/ survives the
 * parent run and would only be reaped by the 6-hour age sweep. With the wrap,
 * it is gone as soon as the recursive executeWorkflow returns.
 */
describe('sub-run staged capture is reclaimed when the recursive rename fails (#2690 R1)', () => {
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
    cwd = join(tmpdir(), `subrun-rename-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');
  });

  afterEach(async () => {
    await removeTempTree(cwd);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
    setForceRenameFailure(false);
  });

  it('reclaims the child staged capture when the recursive rename fails', async () => {
    await writeWorkflow(
      'child-rename-fail',
      `
name: child-rename-fail
description: child whose staged capture rename will be forced to fail
nodes:
  - id: work
    prompt: do work for $ARGUMENTS
`
    );
    await writeWorkflow(
      'parent-rename-fail',
      `
name: parent-rename-fail
description: parent whose sub-run rename will be forced to fail
nodes:
  - id: sub
    workflow: child-rename-fail
    input: the-goal
`
    );

    setForceRenameFailure(true);
    const store = new InMemoryStore();
    try {
      const parent = await discover('parent-rename-fail');
      // The recursive executeWorkflow takes the rename-failure branch and returns
      // {success: false}; runChildWorkflow reads the child back as failed and the
      // `sub` node surfaces that. The parent's run is failed for the same reason.
      const result = await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-plat',
        cwd,
        parent,
        'goal',
        { conversationId: 'conv-db' }
      );
      expect(result.success).toBe(false);

      const child = [...store.runs.values()].find(r => r.workflow_name === 'child-rename-fail');
      expect(child).toBeDefined();
      expect(child?.status).toBe('failed');

      // The assertion that proves the fix. Without the wrap around the recursive
      // call, the child's UUID-named directory under ARCHON_HOME/staged-source/
      // survives the parent run and only the hourly age sweep reclaims it. With
      // the wrap, the wrap's `finally` reclaims the staged tree the moment
      // executeWorkflow returns.
      const stagedDir = join(cwd, 'home', 'staged-source');
      const stagedEntries = await readdir(stagedDir).catch(() => [] as string[]);
      expect(stagedEntries).toEqual([]);
    } finally {
      setForceRenameFailure(false);
    }
  });
});

// #2910: a child's own setup guards record its terminal status too. When one of
// those writes fails, the child has no trustworthy outcome — and the parent must
// not be handed an ordinary "the sub-run errored" node result over a child row
// still sitting at pending/running.
describe("a child's terminal status write fails during setup (#2910)", () => {
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
    cwd = join(tmpdir(), `subrun-setup-write-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');
  });

  afterEach(async () => {
    await removeTempTree(cwd);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  async function writeSubRunPair(): Promise<ResolvedWorkflow> {
    await writeWorkflow(
      'child-setup-write',
      `
name: child-setup-write
description: child whose invocation-metadata write is forced to fail
nodes:
- id: work
  prompt: "work"
`
    );
    await writeWorkflow(
      'parent-setup-write',
      `
name: parent-setup-write
description: parent composing child-setup-write
nodes:
- id: sub
  workflow: child-setup-write
  input: the-goal
- id: after
  prompt: "downstream reads $sub.output"
  depends_on: [sub]
`
    );
    return discover('parent-setup-write');
  }

  /** Fail the child's invocation-metadata persist — the write its recovery covers. */
  function breakChildMetadataWrite(store: InMemoryStore): void {
    const realUpdate = store.updateWorkflowRun.bind(store);
    store.updateWorkflowRun = (id, updates) => {
      const row = store.runs.get(id);
      if (row?.parent_run_id && updates.metadata) {
        return Promise.reject(new Error('child metadata write failed'));
      }
      return realUpdate(id, updates);
    };
  }

  it('fails the parent run rather than reporting an ordinary failed child', async () => {
    const parent = await writeSubRunPair();
    const store = new InMemoryStore();
    breakChildMetadataWrite(store);
    const realFail = store.failWorkflowRun.bind(store);
    store.failWorkflowRun = (id, error) => {
      const row = store.runs.get(id);
      if (row?.parent_run_id) return Promise.reject(new Error('child recovery write failed'));
      return realFail(id, error);
    };

    await expect(
      executeWorkflow(makeDeps(store), makePlatform(), 'conv-plat', cwd, parent, 'goal', {
        conversationId: 'conv-db',
      })
    ).rejects.toThrow('Failed to persist terminal workflow status');

    // The parent must not have carried on past the sub-run node.
    const afterCompleted = store.events.some(
      e => e.event_type === 'node_completed' && e.step_name?.includes('after')
    );
    expect(afterCompleted).toBe(false);
  });

  it('reports an ordinary failed child when the recovery write succeeds', async () => {
    // The other side of the branch: the child's status IS recorded, so the parent
    // gets a normal failed-sub-run outcome instead of a rejection.
    const parent = await writeSubRunPair();
    const store = new InMemoryStore();
    breakChildMetadataWrite(store);

    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(false);
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-setup-write');
    expect(child?.status).toBe('failed');
  });
});
