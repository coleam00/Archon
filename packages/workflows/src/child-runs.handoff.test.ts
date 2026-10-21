// @archon-test-isolated
import { makeDeps, makePlatform } from './child-runs/test-utils';
import { providerRegistry } from '@archon/providers';
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeWorkflow } from './executor';
import { maybeResumeParentRun } from './parent-resume';
import { createFileWorkflowStore } from './file-store/store';
import { hydrateResumableRun } from './run-resume';
import { discoverWorkflows } from './workflow-discovery';
import type { ResolvedWorkflow } from './schemas/workflow';
import { isApprovalContext, type WorkflowRun } from './schemas/workflow-run';

describe('child execution handoff', () => {
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
    cwd = join(tmpdir(), `subrun-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');
  });

  afterEach(async () => {
    await removeTempTree(cwd);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  it.each([false, true].flatMap(fanOut => [false, true].map(readFails => ({ fanOut, readFails }))))(
    'holds a child successor after the old execution loses its claim (options=%j)',
    async ({ fanOut, readFails }) => {
      await writeWorkflow(
        'claim-child',
        `name: claim-child
description: child with an approval gate
nodes:
  - id: review
    approval:
      message: review
`
      );
      await writeWorkflow(
        'claim-parent',
        `name: claim-parent
description: parent waiting for a child
nodes:
  - id: sub
    workflow: claim-child
${fanOut ? '    fan_out:\n      items: \'["first","second"]\'\n      max_parallel: 1\n      join: all_success\n' : ''}`
      );
      const store = await createFileWorkflowStore({ root: join(cwd, 'store') });
      const pause = store.pauseWorkflowRun.bind(store);
      let successor: WorkflowRun | undefined;
      const successors: WorkflowRun[] = [];
      store.pauseWorkflowRun = async (...args) => {
        const run = await store.getWorkflowRun(args[0]);
        if (run?.parent_run_id) {
          await pause(args[0], args[1]);
          successor = await store.resumeWorkflowRun(args[0]);
          successors.push(successor);
        }
        const paused = await pause(...args);
        if (!run?.parent_run_id) {
          expect((await store.getWorkflowRun(args[0]))?.metadata.approval).toMatchObject(
            fanOut
              ? { type: 'fan_out', childRunIds: [successor!.id] }
              : { type: 'child_workflow', childRunId: successor!.id }
          );
        }
        return paused;
      };
      const read = store.getWorkflowRun.bind(store);
      let rejectedReads = 0;
      store.getWorkflowRun = async id => {
        if (readFails && id === successor?.id) {
          rejectedReads++;
          throw new Error('child read-back unavailable');
        }
        return read(id);
      };
      const platform = makePlatform();
      const messages: string[] = [];
      platform.sendMessage = async (_id, text) => {
        messages.push(text);
      };
      const cancel = spyOn(store, 'cancelWorkflowRun');
      const result = await executeWorkflow(
        makeDeps(store),
        platform,
        'conv-plat',
        cwd,
        await discover('claim-parent'),
        'goal',
        { conversationId: 'conv-db' }
      );
      store.getWorkflowRun = read;
      expect(successor).toBeDefined();
      for (const child of successors) {
        expect(await store.getWorkflowRun(child.id)).toEqual(child);
      }
      expect(successor!.status).toBe('running');
      expect(cancel).not.toHaveBeenCalled();
      const parent = await store.getWorkflowRun(result.workflowRunId!);
      const events = await store.listWorkflowEvents(parent!.id);
      if (readFails) {
        expect(rejectedReads).toBeGreaterThan(0);
        expect(parent?.status).toBe('failed');
        expect(
          events.some(event => String(event.data?.error).includes('child read-back unavailable'))
        ).toBe(true);
        return;
      }
      expect(parent?.status).toBe('paused');
      const gate = parent?.metadata.approval;
      expect(isApprovalContext(gate)).toBe(true);
      expect(gate).toMatchObject(
        fanOut
          ? { type: 'fan_out', childRunIds: [successor!.id] }
          : { type: 'child_workflow', childRunId: successor!.id }
      );
      const notice = [...messages].reverse().find(text => text.includes('Blocked on sub-run'));
      if (!fanOut) {
        expect(isApprovalContext(gate) && gate.message).toContain('is running');
        expect(notice).toContain('Waiting for its result');
        expect(notice).not.toContain('Approve');
        expect(notice).not.toContain('awaiting review');
      }
      expect(await store.findChildRuns(parent!.id)).toHaveLength(1);
      expect(events.some(event => event.event_type === 'node_failed')).toBe(false);
    }
  );

  it.each(
    (['completed', 'failed', 'cancelled'] as const).flatMap(terminal =>
      [false, true].map(reentry => ({ terminal, reentry }))
    )
  )('reconciles a child finishing before parent pause (%j)', async ({ terminal, reentry }) => {
    await writeWorkflow(
      'finish-child',
      `name: finish-child
description: child
nodes:
  - id: review
    approval:
      message: review
`
    );
    await writeWorkflow(
      'finish-parent',
      `name: finish-parent
description: parent
nodes:
  - id: sub
    workflow: finish-child
  - id: after
    prompt: downstream
    depends_on: [sub]
`
    );
    const store = await createFileWorkflowStore({ root: join(cwd, 'store') });
    const deps = makeDeps(store);
    const platform = makePlatform();
    const workflow = await discover('finish-parent');
    const pause = store.pauseWorkflowRun.bind(store);
    let childId: string | undefined;
    let finishOnPause = !reentry;
    let finished = false;
    store.pauseWorkflowRun = async (...args) => {
      const run = (await store.getWorkflowRun(args[0]))!;
      if (run.parent_run_id && !reentry && !childId) {
        await pause(args[0], args[1]);
        childId = (await store.resumeWorkflowRun(run.id)).id;
      }
      if (!run.parent_run_id && finishOnPause && !finished) {
        finished = true;
        expect(childId).toBeDefined();
        if (terminal === 'completed') {
          await store.completeWorkflowRun(
            childId!,
            { duration_ms: 1 },
            { summary: 'child result' }
          );
        } else if (terminal === 'failed') {
          await store.failWorkflowRun(childId!, 'child failed');
        } else {
          await store.cancelWorkflowRun(childId!);
        }
        await maybeResumeParentRun(
          deps,
          platform,
          'conv-plat',
          (await store.getWorkflowRun(childId!))!
        );
        expect((await store.getWorkflowRun(run.id))?.status).toBe('running');
      }
      return pause(...args);
    };
    const resume = spyOn(store, 'resumeWorkflowRun');
    let result = await executeWorkflow(deps, platform, 'conv-plat', cwd, workflow, 'goal', {
      conversationId: 'conv-db',
    });
    if (reentry) {
      const child = (await store.findChildRuns(result.workflowRunId!))[0];
      childId = (await store.resumeWorkflowRun(child.id)).id;
      const hydrated = await hydrateResumableRun(
        deps,
        (await store.getWorkflowRun(result.workflowRunId!))!
      );
      finishOnPause = true;
      result = await executeWorkflow(
        deps,
        platform,
        'conv-plat',
        cwd,
        workflow,
        'goal',
        { conversationId: 'conv-db' },
        { ...hydrated! }
      );
    }
    expect(finished).toBe(true);
    const parent = (await store.getWorkflowRun(result.workflowRunId!))!;
    expect(resume.mock.calls.filter(([id]) => id === parent.id)).toHaveLength(reentry ? 2 : 1);
    expect(parent.status).toBe(
      terminal === 'completed' ? 'completed' : terminal === 'cancelled' ? 'failed' : 'paused'
    );
    const child = (await store.getWorkflowRun(childId!))!;
    expect(child.status).toBe(terminal === 'failed' ? 'paused' : terminal);
    const events = await store.listWorkflowEvents(parent.id);
    expect(events.some(e => e.step_name === 'after' && e.event_type === 'node_completed')).toBe(
      terminal === 'completed'
    );
  });
});
