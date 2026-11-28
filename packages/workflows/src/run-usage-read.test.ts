import { describe, expect, it } from 'bun:test';
import {
  readRunUsageReport,
  readRunUsageReports,
  USAGE_REPORT_EVENT_TYPES,
  type RunUsageReadStore,
} from './run-usage-read';
import { finishNodeExecution, newNodeInvocation, startNodeExecution } from './node-execution';
import { serializeDeferredNodeUsage, serializeNodeStateRecord } from './node-record-serialization';
import type { WorkflowRun } from './schemas/workflow-run';
import type { WorkflowEventRow } from './schemas/workflow-event';
import { USAGE_METRICS } from './schemas/run-usage-report';

function run(
  id: string,
  metadata: Record<string, unknown> = {
    total_cost_usd: 0.25,
    total_tokens_in: 4,
    total_tokens_out: 2,
  }
): WorkflowRun {
  return {
    origin: null,
    id,
    workflow_name: 'fixture',
    conversation_id: null,
    parent_conversation_id: null,
    codebase_id: null,
    status: 'completed',
    outcome: null,
    completed_outcome: null,
    user_message: 'PRIVATE_MESSAGE',
    metadata,
    started_at: new Date(),
    active_phase_started_at: null,
    completed_at: new Date(),
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    item_id: null,
  };
}

function agentEvent(runId: string): WorkflowEventRow {
  const started = startNodeExecution({
    runId,
    path: 'build',
    node: { id: 'build', kind: 'agent', source: { kind: 'inline', prompt: 'PRIVATE_PROMPT' } },
    invocation: newNodeInvocation(),
    provider: 'claude',
    sessionId: 'PRIVATE_SESSION',
  });
  const record = serializeNodeStateRecord(
    finishNodeExecution(
      started,
      { status: 'completed' },
      { costUsd: 0.25, tokens: { input: 4, output: 2 }, output: { text: 'PRIVATE_OUTPUT' } }
    )
  );
  return {
    id: `${runId}-event`,
    step_index: null,
    created_at: new Date().toISOString(),
    ...record,
  };
}

function parentEvent(childIds: string[], costUsd = 0.25, runId = 'parent'): WorkflowEventRow {
  return {
    id: `${runId}-event-${childIds.join('-')}`,
    workflow_run_id: runId,
    event_type: 'node_completed',
    step_name: 'children',
    step_index: null,
    created_at: new Date().toISOString(),
    data: {
      type: 'workflow',
      cost_usd: costUsd,
      tokens: { input: 4, output: 2 },
      child_usage: childIds.map(childRunId => ({
        childRunId,
        costUsd: 0.25,
        tokens: { input: 4, output: 2 },
      })),
    },
  };
}

function source(runs: WorkflowRun[], events: WorkflowEventRow[]) {
  const calls: { ids: readonly string[]; eventTypes: readonly string[]; strict?: boolean }[] = [];
  const childBatches: string[][] = [];
  const store: RunUsageReadStore = {
    listEventsForRuns: async (ids, eventTypes, options) => {
      calls.push({ ids, eventTypes, strict: options?.strict });
      return new Map(
        ids.map(id => [
          id,
          events.filter(
            event =>
              event.workflow_run_id === id && eventTypes.some(type => type === event.event_type)
          ),
        ])
      );
    },
    getWorkflowRunsByIds: async ids => {
      childBatches.push([...ids]);
      return runs.filter(row => ids.includes(row.id));
    },
  };
  return { store, calls, childBatches };
}

describe('strict usage history reads', () => {
  it('batches roots with strict filtered event reads, excludes provider streams and performs no writes', async () => {
    const roots = [run('one'), run('two')];
    const fixture = source(
      roots,
      roots.map(root => agentEvent(root.id))
    );
    const reports = await readRunUsageReports(fixture.store, roots);
    expect(fixture.calls).toEqual([
      { ids: ['one', 'two'], eventTypes: USAGE_REPORT_EVENT_TYPES, strict: true },
    ]);
    expect(fixture.calls[0].eventTypes).not.toContain('provider_event');
    expect(fixture.childBatches).toEqual([]);
    expect(reports.get('one')?.coverage.usd.state).toBe('complete');
    expect(reports.get('two')?.coverage.usd.state).toBe('complete');
    for (const marker of ['PRIVATE_MESSAGE', 'PRIVATE_PROMPT', 'PRIVATE_SESSION', 'PRIVATE_OUTPUT'])
      expect(JSON.stringify([...reports])).not.toContain(marker);
  });

  it('preserves totals and records every run unavailable when each strict read fails', async () => {
    const roots = [run('one'), run('two')];
    const fixture = source(roots, []);
    let attempts = 0;
    fixture.store.listEventsForRuns = async () => {
      attempts++;
      throw new Error('unavailable');
    };
    const reports = await readRunUsageReports(fixture.store, roots);
    expect(attempts).toBe(3);
    for (const root of roots) {
      const report = reports.get(root.id);
      expect(report?.totals.usd).toBe(0.25);
      expect(report?.coverage.usd).toMatchObject({
        state: 'unknown',
        recordedNodes: 0,
        expectedNodes: null,
      });
      expect(report?.coverage.usd.gaps).toContainEqual({ reason: 'history_unavailable' });
    }
  });

  it('keeps a readable sibling when another root history fails its strict read', async () => {
    const roots = [run('bad'), run('good')];
    const fixture = source(roots, [agentEvent('good')]);
    fixture.store.listEventsForRuns = async ids => {
      if (ids.includes('bad')) JSON.parse('{');
      return new Map([['good', [agentEvent('good')]]]);
    };
    const reports = await readRunUsageReports(fixture.store, roots);
    expect(reports.get('good')?.coverage.usd.state).toBe('complete');
    expect(reports.get('bad')?.coverage.usd.gaps).toContainEqual({
      reason: 'history_unavailable',
    });
  });

  it('keeps a readable referenced child when its sibling history fails', async () => {
    const parent = parentEvent(['bad', 'good'], 0.5);
    parent.data.tokens = { input: 8, output: 4 };
    const fixture = source([run('bad'), run('good')], [parent, agentEvent('good')]);
    fixture.store.listEventsForRuns = async ids => {
      if (ids.includes('bad')) JSON.parse('{');
      return new Map(
        ids.map(id => [id, id === 'parent' ? [parent] : id === 'good' ? [agentEvent('good')] : []])
      );
    };
    const report = await readRunUsageReport(
      fixture.store,
      run('parent', { total_cost_usd: 0.5, total_tokens_in: 8, total_tokens_out: 4 })
    );
    expect(report.coverage.usd).toMatchObject({ recordedNodes: 1, expectedNodes: null });
    expect(report.coverage.usd.gaps).toContainEqual({
      runId: 'bad',
      reason: 'history_unavailable',
    });
  });

  it('degrades only the run carrying malformed typed metadata', async () => {
    const roots = [run('bad'), run('good')];
    const malformed = agentEvent('bad');
    malformed.data = { ...malformed.data, invocation: { invalid: true } };
    const fixture = source(roots, [malformed, agentEvent('good')]);
    const reports = await readRunUsageReports(fixture.store, roots);
    expect(reports.get('bad')?.coverage.usd.gaps).toContainEqual({
      path: 'build',
      reason: 'record_unreadable',
    });
    expect(reports.get('good')?.coverage.usd.state).toBe('complete');
  });

  it('strict malformed JSON remains unavailable instead of an empty certified population', async () => {
    const fixture = source([run('bad')], []);
    fixture.store.listEventsForRuns = async () => {
      JSON.parse('{');
      return new Map();
    };
    const report = await readRunUsageReport(fixture.store, run('bad'));
    expect(report.coverage.usd.state).toBe('unknown');
    expect(report.coverage.usd.gaps).toContainEqual({ reason: 'history_unavailable' });
  });

  it.each([null, ''])('names a node usage row whose path is %s', async stepName => {
    const missing = agentEvent('bad');
    missing.step_name = stepName;
    const fixture = source([run('bad'), run('good')], [missing, agentEvent('good')]);
    const reports = await readRunUsageReports(fixture.store, [run('bad'), run('good')]);
    expect(reports.get('bad')?.coverage.usd.gaps).toContainEqual({
      reason: 'record_unreadable',
    });
    expect(reports.get('bad')?.coverage.usd.state).not.toBe('complete');
    expect(reports.get('good')?.coverage.usd.state).toBe('complete');
  });

  it('names deferred usage without a path but ignores a node-less completion row', async () => {
    const started = startNodeExecution({
      runId: 'bad',
      path: 'build',
      node: { id: 'build', kind: 'agent', source: { kind: 'inline', prompt: 'p' } },
      invocation: newNodeInvocation(),
      provider: 'claude',
    });
    const deferred = serializeDeferredNodeUsage(
      finishNodeExecution(started, { status: 'suspended', point: 'interactive_loop' }, {})
    );
    const missing: WorkflowEventRow = {
      ...deferred,
      id: 'deferred-without-path',
      workflow_run_id: 'bad',
      step_index: null,
      step_name: null,
      created_at: new Date().toISOString(),
    };
    const completed: WorkflowEventRow = {
      id: 'completed',
      workflow_run_id: 'bad',
      event_type: 'workflow_completed',
      step_index: null,
      step_name: null,
      data: {},
      created_at: new Date().toISOString(),
    };
    const fixture = source([run('bad')], [missing, completed]);
    const report = await readRunUsageReport(fixture.store, run('bad'));
    expect(report.coverage.usd.gaps.filter(gap => gap.reason === 'record_unreadable')).toEqual([
      { reason: 'record_unreadable' },
    ]);
  });

  it('expands matching child baselines using qualified nodes without adding child totals', async () => {
    const fixture = source([run('child')], [parentEvent(['child']), agentEvent('child')]);
    const report = await readRunUsageReport(fixture.store, run('parent'));
    expect(report.totals).toEqual({ usd: 0.25, inputTokens: 4, outputTokens: 2 });
    for (const metric of USAGE_METRICS) {
      expect(report.coverage[metric]).toEqual({
        state: 'complete',
        recordedNodes: 1,
        expectedNodes: 1,
        gaps: [],
      });
    }
    expect(fixture.childBatches).toEqual([['child']]);
  });

  it('reads sibling children once, including repeated references', async () => {
    const event = parentEvent(['one', 'two'], 0.5);
    event.data.tokens = { input: 8, output: 4 };
    const fixture = source([run('one'), run('two')], [event, agentEvent('one'), agentEvent('two')]);
    const report = await readRunUsageReport(
      fixture.store,
      run('parent', { total_cost_usd: 0.5, total_tokens_in: 8, total_tokens_out: 4 })
    );
    expect(report.coverage.usd).toMatchObject({
      state: 'complete',
      recordedNodes: 2,
      expectedNodes: 2,
    });
    expect(fixture.childBatches).toEqual([['one', 'two']]);
  });

  it('refuses child attribution on every mismatched metric, never replaces the parent amount', async () => {
    const child = run('child', { total_cost_usd: 3, total_tokens_in: 40, total_tokens_out: 20 });
    const fixture = source([child], [parentEvent(['child']), agentEvent('child')]);
    const report = await readRunUsageReport(fixture.store, run('parent'));
    expect(report.totals).toEqual({ usd: 0.25, inputTokens: 4, outputTokens: 2 });
    for (const metric of USAGE_METRICS) {
      expect(report.coverage[metric].state).not.toBe('complete');
      expect(report.coverage[metric].gaps).toContainEqual({
        runId: 'child',
        path: 'children',
        reason: 'child_usage_mismatch',
      });
    }
  });

  it('names deleted children and retains already charged replaced children', async () => {
    const replaced = parentEvent(['old']);
    const current = parentEvent(['new']);
    const fixture = source([run('new')], [replaced, current, agentEvent('new')]);
    const report = await readRunUsageReport(
      fixture.store,
      run('parent', { total_cost_usd: 0.5, total_tokens_in: 8, total_tokens_out: 4 })
    );
    expect(fixture.childBatches).toEqual([['old', 'new']]);
    expect(report.totals.usd).toBe(0.5);
    expect(report.coverage.usd).toMatchObject({
      state: 'partial',
      recordedNodes: 1,
      expectedNodes: null,
    });
    expect(report.coverage.usd.gaps).toContainEqual({
      runId: 'old',
      path: 'children',
      reason: 'child_unavailable',
    });
  });

  it('does not invent an allocation for historical multi-child increments', async () => {
    const event = parentEvent([]);
    const { child_usage: _childUsage, ...legacy } = event.data;
    event.data = legacy;
    event.data.fan_out_outcome = { slots: [] };
    const fixture = source([], [event]);
    const report = await readRunUsageReport(fixture.store, run('parent'));
    expect(report.totals.usd).toBe(0.25);
    expect(report.coverage.usd.expectedNodes).toBeNull();
    expect(report.coverage.usd.gaps).toContainEqual({
      path: 'children',
      reason: 'scope_unattributed',
    });
  });

  it('terminates corrupt child cycles without another database read', async () => {
    const event = parentEvent(['parent']);
    const fixture = source([], [event]);
    const report = await readRunUsageReport(fixture.store, run('parent'));
    expect(fixture.childBatches).toEqual([]);
    expect(report.coverage.usd.gaps).toContainEqual({
      path: 'children',
      reason: 'child_cycle',
    });
  });

  it('keeps convergent cycle reports independent of batch root order', async () => {
    const roots = [run('a'), run('b'), run('c'), run('d')];
    const fixture = source(roots, [
      parentEvent(['b'], 0.25, 'a'),
      parentEvent(['c'], 0.25, 'b'),
      parentEvent(['a'], 0.25, 'c'),
      parentEvent(['b'], 0.25, 'd'),
    ]);
    const batch = await readRunUsageReports(fixture.store, [roots[0], roots[3]]);
    for (const root of [roots[0], roots[3]]) {
      const isolated = await readRunUsageReport(fixture.store, root);
      expect(batch.get(root.id)).toEqual(isolated);
    }
    expect(batch.get('d')?.coverage.usd.gaps).toContainEqual({
      runId: 'b',
      path: 'children',
      reason: 'child_cycle',
    });
  });

  it('preserves readable own usage when a child batch rejects', async () => {
    const fixture = source([], [parentEvent(['missing'])]);
    fixture.store.getWorkflowRunsByIds = async () => {
      throw new Error('unavailable');
    };
    const report = await readRunUsageReport(fixture.store, run('parent'));
    expect(report.totals.usd).toBe(0.25);
    expect(report.coverage.usd.gaps).toContainEqual({
      runId: 'missing',
      path: 'children',
      reason: 'child_unavailable',
    });
  });

  it('keeps readable siblings when one child row rejects the batch', async () => {
    const fixture = source([run('good')], [parentEvent(['bad', 'good']), agentEvent('good')]);
    fixture.store.getWorkflowRunsByIds = async ids => {
      if (ids.includes('bad')) throw new Error('malformed child row');
      return [run('good')].filter(row => ids.includes(row.id));
    };
    const report = await readRunUsageReport(fixture.store, run('parent'));
    expect(report.totals.usd).toBe(0.25);
    expect(report.coverage.usd.recordedNodes).toBe(1);
    expect(report.coverage.usd.gaps).toContainEqual({
      runId: 'bad',
      path: 'children',
      reason: 'child_unavailable',
    });
  });

  it('does not certify a child inside an opaque authoritative instance', async () => {
    const leaf = parentEvent(['child']);
    leaf.step_name = 'fan__item__children';
    const wrapper: WorkflowEventRow = {
      id: 'wrapper',
      workflow_run_id: 'parent',
      step_name: 'fan__item',
      step_index: null,
      event_type: 'node_completed',
      created_at: '2026-11-25T00:00:00Z',
      data: {
        type: 'compose_fan_out_instance',
        cost_usd: 5,
        tokens: { input: 40, output: 20 },
        cost_scope: 'total',
      },
    };
    const fixture = source([run('child')], [leaf, wrapper, agentEvent('child')]);
    const report = await readRunUsageReport(
      fixture.store,
      run('parent', { total_cost_usd: 5, total_tokens_in: 40, total_tokens_out: 20 })
    );
    expect(report.totals.usd).toBe(5);
    expect(report.coverage.usd.state).not.toBe('complete');
    expect(report.coverage.usd.expectedNodes).toBeNull();
    expect(report.coverage.usd.gaps).toContainEqual({
      path: 'fan__item',
      reason: 'scope_unattributed',
    });
  });

  it('certifies a child baseline recorded after an opaque instance terminal', async () => {
    const before = parentEvent(['child']);
    before.step_name = 'fan__item__children';
    const wrapper: WorkflowEventRow = {
      id: 'wrapper',
      workflow_run_id: 'parent',
      step_name: 'fan__item',
      step_index: null,
      event_type: 'node_completed',
      created_at: '2026-11-25T00:00:00Z',
      data: {
        type: 'compose_fan_out_instance',
        cost_usd: 5,
        tokens: { input: 40, output: 20 },
        cost_scope: 'total',
      },
    };
    const after = parentEvent(['child']);
    after.id = 'after';
    after.step_name = 'fan__item__children';
    const fixture = source([run('child')], [before, wrapper, after, agentEvent('child')]);
    const report = await readRunUsageReport(
      fixture.store,
      run('parent', { total_cost_usd: 5.25, total_tokens_in: 44, total_tokens_out: 22 })
    );
    expect(report.coverage.usd.recordedNodes).toBe(1);
    expect(report.coverage.usd.gaps).toContainEqual({
      path: 'fan__item',
      reason: 'scope_unattributed',
    });
  });
});
