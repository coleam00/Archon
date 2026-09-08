import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerBuiltinProviders, getProviderCapabilities } from '@archon/providers';
import type { IAgentProvider } from '@archon/providers/types';
import {
  admitWorkflowTrigger,
  type TriggerBinding,
  type TriggerEvent,
} from '@archon/workflows/trigger';
import { Pool } from 'pg';

const root = await mkdtemp(join(tmpdir(), 'archon-trigger-'));
const previousHome = process.env.ARCHON_HOME;
const previousDatabase = process.env.DATABASE_URL;
process.env.ARCHON_HOME = join(root, 'home');
const pgUrl = process.env.ARCHON_TEST_PG_URL;
const admin = pgUrl ? new Pool({ connectionString: pgUrl }) : undefined;
const scratchName = `archon_trigger_${crypto.randomUUID().replaceAll('-', '')}`;
if (admin && pgUrl) {
  await admin.query(`CREATE DATABASE "${scratchName}"`);
  const scratchUrl = new URL(pgUrl);
  scratchUrl.pathname = `/${scratchName}`;
  process.env.DATABASE_URL = scratchUrl.toString();
} else process.env.DATABASE_URL = '';
process.env.ARCHON_TELEMETRY_DISABLED = '1';
registerBuiltinProviders();
const { closeDatabase, getDatabase } = await import('../db/connection');
const { createCodebase } = await import('../db/codebases');
const { getOrCreateConversation } = await import('../db/conversations');
const { getWorkflowRun, cancelWorkflowRun, updateWorkflowRun } = await import('../db/workflows');
const { createWorkflowTriggerStore } = await import('../db/workflow-triggers');
const { createWorkflowDeps } = await import('../workflows/store-adapter');
const { deliverWorkflowTrigger } = await import('../workflows/trigger-launch');
const { signalWorkflowWait } = await import('../db/workflows');
const { workflowWaitContextSchema } = await import('@archon/workflows/schemas/workflow-run');
const { executeWorkflow, hydrateResumableRun, resolveContinuationWorkflow } =
  await import('@archon/workflows/executor');

afterAll(async () => {
  await closeDatabase();
  if (admin) {
    await admin.query(`DROP DATABASE "${scratchName}"`);
    await admin.end();
  }
  await removeTempTree(root);
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
  if (previousDatabase === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabase;
});

let calls = 0;
const provider: IAgentProvider = {
  getType: () => 'claude',
  getCapabilities: () => getProviderCapabilities('claude'),
  async *sendQuery() {
    calls++;
    yield { type: 'assistant', content: 'declared node output' };
    yield { type: 'result', sessionId: 'trigger-test-session' };
  },
};
const deps = { ...createWorkflowDeps(), getAgentProvider: () => provider };

async function fixture(nodes: string, name = `trigger-${crypto.randomUUID()}`) {
  const cwd = join(root, name);
  await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
  await writeFile(
    join(cwd, '.archon', 'config.yaml'),
    'defaults:\n  loadDefaultWorkflows: false\n'
  );
  await writeFile(
    join(cwd, '.archon', 'workflows', 'run.yaml'),
    `name: intake\ndescription: Trigger fixture\nworktree:\n  enabled: false\ninputs:\n  tick:\n    required: true\nnodes:\n${nodes}\n`
  );
  const codebase = await createCodebase({ name, default_cwd: cwd, kind: 'folder' });
  const binding: TriggerBinding = {
    id: name,
    kind: 'schedule',
    scheduleId: name,
    workflow: 'intake',
    sourceRoot: cwd,
    source: 'project',
    codebaseId: codebase.id,
    overlap: 'skip',
    inputs: {},
    facts: { tick: 'tick' },
  };
  const event: TriggerEvent = {
    kind: 'schedule',
    scheduleId: name,
    eventId: 'tick-1',
    tick: '2026-09-08T12:00:00Z',
  };
  return { cwd, binding, event };
}

describe('native trigger admission and execution with real persistence', () => {
  test('native cleanup retains admitted runs and their events while deleting unrelated history', async () => {
    const { createWorkflowRun, deleteOldWorkflowRuns, deleteWorkflowRun } =
      await import('../db/workflows');
    const conversation = await getOrCreateConversation('cli', crypto.randomUUID());
    const triggerId = crypto.randomUUID();
    const admitted = await createWorkflowTriggerStore().admit({
      triggerId,
      eventId: 'retained',
      overlap: 'skip',
      run: {
        id: crypto.randomUUID(),
        workflow_name: 'intake',
        conversation_id: conversation.id,
        user_message: '',
      },
    });
    const unrelated = await createWorkflowRun({
      workflow_name: 'intake',
      conversation_id: conversation.id,
      user_message: '',
    });
    await cancelWorkflowRun(admitted.runId);
    await cancelWorkflowRun(unrelated.id);
    await getDatabase().query(
      "UPDATE remote_agent_workflow_runs SET started_at = '2000-01-01T00:00:00Z' WHERE id IN ($1, $2)",
      [admitted.runId, unrelated.id]
    );
    expect((await deleteOldWorkflowRuns(1)).count).toBe(1);
    expect(await getWorkflowRun(unrelated.id)).toBeNull();
    await expect(deleteWorkflowRun(admitted.runId)).rejects.toThrow();
    expect(await createWorkflowTriggerStore().getAdmission(triggerId, 'retained')).toEqual({
      disposition: 'duplicate',
      runId: admitted.runId,
    });
    const events = await getDatabase().query(
      'SELECT id FROM remote_agent_workflow_events WHERE workflow_run_id = $1',
      [admitted.runId]
    );
    expect(events.rows.length).toBeGreaterThan(0);
  });
  test('cancellation between admission and executor startup cannot be overwritten', async () => {
    const conversation = await getOrCreateConversation('cli', crypto.randomUUID());
    const store = createWorkflowTriggerStore();
    const admitted = await store.admit({
      triggerId: crypto.randomUUID(),
      eventId: 'event',
      overlap: 'skip',
      run: {
        id: crypto.randomUUID(),
        workflow_name: 'intake',
        conversation_id: conversation.id,
        user_message: '',
      },
    });
    expect(await store.claimPendingRun(admitted.runId)).not.toBeNull();
    await cancelWorkflowRun(admitted.runId);
    await expect(updateWorkflowRun(admitted.runId, { status: 'running' })).rejects.toThrow();
    expect((await getWorkflowRun(admitted.runId))?.status).toBe('cancelled');
  });
  test('native signal and resume preserve the admitted run, frozen node and event identity', async () => {
    const f = await fixture(
      '  - id: ready\n    wait:\n      event: proceed\n      deadline_ms: 3600000\n  - id: judge\n    depends_on: [ready]\n    prompt: Evaluate $INPUTS.tick'
    );
    const before = calls;
    const delivery = await deliverWorkflowTrigger(f.binding, f.event, deps);
    await delivery.completion;
    const paused = await getWorkflowRun(delivery.admission.runId);
    if (!paused) throw new Error('Run missing');
    const wait = workflowWaitContextSchema.parse(paused.metadata.wait);
    if (wait.kind !== 'event') throw new Error('Wrong wait kind');
    expect(calls).toBe(before);
    await signalWorkflowWait(paused.id, wait);
    const signaled = await getWorkflowRun(paused.id);
    if (!signaled) throw new Error('Run missing');
    const resolved = await resolveContinuationWorkflow(deps, signaled, f.cwd);
    const hydrated = await hydrateResumableRun(deps, signaled);
    if (!resolved || !hydrated) throw new Error('Native resume did not resolve the run');
    const result = await executeWorkflow(
      deps,
      { async sendMessage() {}, getStreamingMode: () => 'batch', getPlatformType: () => 'cli' },
      'resume',
      f.cwd,
      resolved.workflow,
      '',
      paused.conversation_id,
      { ...hydrated, codebaseId: f.binding.codebaseId }
    );
    expect(result).toMatchObject({ success: true, workflowRunId: paused.id });
    expect(calls - before).toBe(1);
    expect((await deliverWorkflowTrigger(f.binding, f.event, deps)).completion).toBeUndefined();
  });
  test('concurrent duplicates run only the declared node, with exact source and run identity; restart deduplicates completed runs', async () => {
    const f = await fixture('  - id: judge\n    prompt: Evaluate $INPUTS.tick');
    f.binding.id = 'binding'.padEnd(256, 'x');
    f.event.eventId = 'event'.padEnd(256, 'x');
    const before = calls;
    const deliveries = await Promise.all(
      Array.from({ length: 4 }, () => deliverWorkflowTrigger(f.binding, f.event, deps))
    );
    await Promise.all(deliveries.map(delivery => delivery.completion));
    const ids = new Set(deliveries.map(delivery => delivery.admission.runId));
    expect(ids.size).toBe(1);
    expect(calls - before).toBe(1);
    const run = await getWorkflowRun(deliveries[0].admission.runId);
    expect(run?.status).toBe('completed');
    expect(run?.workflow_name).toBe('intake');
    expect(run?.metadata.trigger).toEqual({ binding: f.binding, event: f.event });
    expect(run?.metadata.workflow_source).toMatchObject({ origin: f.cwd });
    const events = await getDatabase().query<{ step_name: string }>(
      "SELECT step_name FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'node_started'",
      [run!.id]
    );
    expect(events.rows.map(row => row.step_name)).toEqual(['judge']);
    await closeDatabase();
    const duplicate = await deliverWorkflowTrigger(f.binding, f.event, deps);
    expect(duplicate.admission).toEqual({ disposition: 'duplicate', runId: run!.id });
    expect(duplicate.completion).toBeUndefined();
    expect(calls - before).toBe(1);
  });

  test('admission without launch recovers after restart using frozen source', async () => {
    const f = await fixture('  - id: judge\n    prompt: Evaluate $INPUTS.tick');
    const conversation = await getOrCreateConversation('cli', crypto.randomUUID());
    const admission = await admitWorkflowTrigger(deps, createWorkflowTriggerStore(), {
      ...f,
      conversationId: conversation.id,
    });
    await closeDatabase();
    await writeFile(join(f.cwd, '.archon', 'workflows', 'run.yaml'), 'invalid: now');
    const recovered = await deliverWorkflowTrigger(f.binding, f.event, deps);
    expect(recovered.admission.runId).toBe(admission.runId);
    expect((await recovered.completion)?.success).toBe(true);
  });

  test('claimed execution never retries implicitly after restart', async () => {
    const conversation = await getOrCreateConversation('cli', crypto.randomUUID());
    const uncertain = await admitWorkflowTrigger(deps, createWorkflowTriggerStore(), {
      ...(await fixture('  - id: judge\n    prompt: Evaluate $INPUTS.tick')),
      conversationId: conversation.id,
    });
    expect(await createWorkflowTriggerStore().claimPendingRun(uncertain.runId)).not.toBeNull();
    await closeDatabase();
    expect(await createWorkflowTriggerStore().claimPendingRun(uncertain.runId)).toBeNull();
    expect((await getWorkflowRun(uncertain.runId))?.status).toBe('running');
    await cancelWorkflowRun(uncertain.runId);
  });

  test('an accepted commit with a lost response retains its source and recovers the same run', async () => {
    const f = await fixture('  - id: judge\n    prompt: Evaluate $INPUTS.tick');
    const conversation = await getOrCreateConversation('cli', crypto.randomUUID());
    const store = createWorkflowTriggerStore();
    await expect(
      admitWorkflowTrigger(
        deps,
        {
          ...store,
          async admit(params) {
            await store.admit(params);
            throw new Error('Injected lost commit response');
          },
        },
        { ...f, conversationId: conversation.id }
      )
    ).rejects.toThrow('Injected lost commit response');
    await closeDatabase();
    const committed = await createWorkflowTriggerStore().getAdmission(
      f.binding.id,
      f.event.eventId
    );
    expect(committed).not.toBeNull();
    const recovered = await deliverWorkflowTrigger(f.binding, f.event, deps);
    expect(recovered.admission.runId).toBe(committed!.runId);
    expect((await recovered.completion)?.success).toBe(true);
  });

  test('failed runs with a scheduled quota continuation hold overlap', async () => {
    const store = createWorkflowTriggerStore();
    const conversation = await getOrCreateConversation('cli', crypto.randomUUID());
    const triggerId = crypto.randomUUID();
    const create = (eventId: string) =>
      store.admit({
        triggerId,
        eventId,
        overlap: 'skip',
        run: {
          id: crypto.randomUUID(),
          workflow_name: 'intake',
          conversation_id: conversation.id,
          user_message: '',
        },
      });
    const first = await create('one');
    await store.claimPendingRun(first.runId);
    const { failWorkflowRun } = await import('../db/workflows');
    await failWorkflowRun(first.runId, 'quota', {
      reason: 'quota',
      resumeAt: '2026-09-09T12:00:00Z',
      deadlineAt: '2026-09-10T12:00:00Z',
      attempt: 1,
      maxAttempts: 3,
    });
    expect((await create('two')).disposition).toBe('skipped');
    await cancelWorkflowRun(first.runId);
    expect((await create('three')).disposition).toBe('accepted');
  });

  test('paused runs hold ticks durably; skipped deliveries stay skipped after cancellation', async () => {
    const f = await fixture(
      '  - id: wait\n    wait:\n      event: release\n      deadline_ms: 3600000'
    );
    const first = await deliverWorkflowTrigger(f.binding, f.event, deps);
    await first.completion;
    expect((await getWorkflowRun(first.admission.runId))?.status).toBe('paused');
    const tick2 = { ...f.event, eventId: 'tick-2' };
    const held = await deliverWorkflowTrigger(f.binding, tick2, deps);
    expect(held.admission).toEqual({ disposition: 'skipped', runId: first.admission.runId });
    await cancelWorkflowRun(first.admission.runId);
    await closeDatabase();
    expect((await deliverWorkflowTrigger(f.binding, tick2, deps)).admission).toEqual(
      held.admission
    );
    expect((await deliverWorkflowTrigger(f.binding, f.event, deps)).completion).toBeUndefined();
  });

  test.each(['missing workflow', 'wrong source', 'undeclared input', 'ambiguous source'])(
    '%s fails before provider or admission',
    async failure => {
      const f = await fixture('  - id: judge\n    prompt: Evaluate $INPUTS.tick');
      const before = calls;
      const binding = { ...f.binding };
      if (failure === 'missing workflow') binding.workflow = 'missing';
      if (failure === 'wrong source') binding.source = 'global';
      if (failure === 'undeclared input') binding.inputs = { prompt: 'arbitrary' };
      if (failure === 'ambiguous source')
        await writeFile(
          join(f.cwd, '.archon', 'workflows', 'duplicate.yaml'),
          'name: intake\ndescription: Ambiguous intake\nnodes:\n  - id: wrong\n    prompt: Never run'
        );
      await expect(deliverWorkflowTrigger(binding, f.event, deps)).rejects.toThrow();
      expect(calls).toBe(before);
      expect(
        await createWorkflowTriggerStore().getAdmission(f.binding.id, f.event.eventId)
      ).toBeNull();
    }
  );

  test('malformed event input fails before provider or admission', async () => {
    const f = await fixture('  - id: judge\n    prompt: Evaluate $INPUTS.tick');
    const before = calls;
    await expect(
      deliverWorkflowTrigger(f.binding, { ...f.event, command: 'bad' }, deps)
    ).rejects.toThrow();
    expect(calls).toBe(before);
    expect(
      await createWorkflowTriggerStore().getAdmission(f.binding.id, f.event.eventId)
    ).toBeNull();
  });

  test('failed run insertion rolls back admission and permits a corrected delivery', async () => {
    const store = createWorkflowTriggerStore();
    const params = {
      triggerId: crypto.randomUUID(),
      eventId: 'event',
      overlap: 'skip' as const,
      run: {
        id: crypto.randomUUID(),
        workflow_name: 'intake',
        conversation_id: crypto.randomUUID(),
        user_message: '',
      },
    };
    await expect(store.admit(params)).rejects.toThrow();
    expect(await store.getAdmission(params.triggerId, params.eventId)).toBeNull();
    const conversation = await getOrCreateConversation('cli', crypto.randomUUID());
    const accepted = await store.admit({
      ...params,
      run: { ...params.run, conversation_id: conversation.id },
    });
    expect(accepted.disposition).toBe('accepted');
    await cancelWorkflowRun(accepted.runId);
  });
});
