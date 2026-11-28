import { describe, expect, it } from 'bun:test';
import { countedUsage, foldDagUsage } from './dag-usage-fold';
import { finishNodeExecution, newNodeInvocation, startNodeExecution } from './node-execution';
import { serializeNodeStateRecord, serializeDeferredNodeUsage } from './node-record-serialization';
import { buildRunUsageReport, collectRunUsageEvidence } from './run-usage-report';
import { formatUsageReport } from './run-usage-format';
import { runUsageReportSchema, USAGE_METRICS } from './schemas/run-usage-report';
import { serializeRunUsage } from './schemas/run-usage';
import type { DagResumeEvent } from './dag-resume-snapshot';

function agent(
  path: string,
  observations: Parameters<typeof finishNodeExecution>[2] = {},
  fields: { runId?: string; provider?: string; failed?: boolean } = {}
) {
  const start = startNodeExecution({
    runId: fields.runId ?? 'run',
    path,
    node: { id: path, kind: 'agent', source: { kind: 'inline', prompt: 'PRIVATE_PROMPT' } },
    invocation: newNodeInvocation([{ groupId: 'rounds', iteration: 2 }]),
    provider: fields.provider ?? 'claude',
    sessionId: 'PRIVATE_SESSION',
  });
  return finishNodeExecution(
    start,
    fields.failed ? { status: 'failed', error: 'PRIVATE_ERROR' } : { status: 'completed' },
    observations
  );
}

function report(events: readonly DagResumeEvent[], metadata?: Record<string, unknown>) {
  const fold = foldDagUsage(events, 'run');
  return buildRunUsageReport(
    { id: 'run', metadata: metadata ?? serializeRunUsage(countedUsage(fold)) },
    fold
  );
}

const measured = { costUsd: 0.25, tokens: { input: 4, output: 2 } };

describe('recorded usage coverage', () => {
  it('names a node once, however many of its rows and graph entries lack a kind', () => {
    const kinds: DagResumeEvent[] = ['node_started', 'node_completed'].map(event_type => ({
      event_type,
      step_name: 'odd',
      data: { type: 'future-kind', cost_usd: 0.25, tokens: measured.tokens },
    }));
    const result = report(kinds, { terminal_graph: { node_ids: ['odd'] } });
    expect(
      result.coverage.usd.gaps.filter(gap => gap.reason === 'node_kind_unavailable')
    ).toHaveLength(1);
  });

  it('certifies every metric from actual execution evidence and preserves only usage identities', () => {
    const record = agent('build', { ...measured, output: { text: 'PRIVATE_OUTPUT' } });
    const result = report([serializeNodeStateRecord(record)]);
    expect(result.totals).toEqual({ usd: 0.25, inputTokens: 4, outputTokens: 2 });
    for (const metric of USAGE_METRICS) {
      expect(result.coverage[metric]).toEqual({
        state: 'complete',
        recordedNodes: 1,
        expectedNodes: 1,
        gaps: [],
      });
    }
    expect(runUsageReportSchema.parse(result)).toEqual(result);
    const json = JSON.stringify(result);
    for (const marker of ['PRIVATE_PROMPT', 'PRIVATE_OUTPUT', 'PRIVATE_SESSION', 'PRIVATE_ERROR'])
      expect(json).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain(record.invocation.id);
    expect(JSON.stringify(result)).not.toContain(record.attempt.id);
    expect(formatUsageReport(result)).toEqual([
      '  Usage: cost $0.25, input tokens 4, output tokens 2, recorded by all 1/1 AI nodes.',
    ]);
  });

  it('stays small: one mixed node pair reports in a few hundred bytes', () => {
    const paid = serializeNodeStateRecord(agent('build', measured));
    const unsupported = agent('review', measured);
    unsupported.spend.costUsd = { source: 'unavailable', reason: 'unsupported' };
    const result = report([paid, serializeNodeStateRecord(unsupported)]);
    expect(JSON.stringify(result).length).toBeLessThan(450);
    expect(result.coverage).toEqual({
      usd: {
        state: 'partial',
        recordedNodes: 1,
        expectedNodes: 2,
        gaps: [{ path: 'review', reason: 'unsupported' }],
      },
      inputTokens: { state: 'complete', recordedNodes: 2, expectedNodes: 2, gaps: [] },
      outputTokens: { state: 'complete', recordedNodes: 2, expectedNodes: 2, gaps: [] },
    });
    expect(formatUsageReport(result)).toEqual([
      '  Usage: cost $0.25 (partial; 1/2 AI nodes recorded), input tokens 8 (complete; 2/2 AI nodes recorded), output tokens 4 (complete; 2/2 AI nodes recorded).',
      '    review: cost not recorded (unsupported)',
    ]);
  });

  it('keeps token coverage complete when only a duplicate terminal cost disagrees', () => {
    const record = agent('build', measured);
    const again = finishNodeExecution(
      record,
      { status: 'completed' },
      { ...measured, costUsd: 0.5 }
    );
    const result = report([serializeNodeStateRecord(record), serializeNodeStateRecord(again)]);
    expect(result.coverage.usd.gaps).toContainEqual({ path: 'build', reason: 'record_unreadable' });
    expect(result.coverage.inputTokens.state).toBe('complete');
    expect(result.coverage.outputTokens.state).toBe('complete');
    expect(result.coverage.inputTokens.expectedNodes).not.toBeNull();
    // Both rows name the same node, so the conflict hides no node.
    expect(result.coverage.usd.expectedNodes).toBe(1);
  });

  it('certifies a node only when its usage figure and typed spend agree', () => {
    const event = serializeNodeStateRecord(agent('build', measured));
    event.data.cost_usd = 0.5;
    const result = report([event]);
    expect(result.totals.usd).toBe(0.5);
    expect(result.coverage.usd.state).toBe('unknown');
    expect(result.coverage.usd).toMatchObject({ recordedNodes: 1, expectedNodes: 1 });
    expect(result.coverage.usd.gaps).toEqual([{ path: 'build', reason: 'record_unreadable' }]);
    expect(result.coverage.inputTokens.state).toBe('complete');
  });

  it('separates unsupported cost from complete gross-token coverage', () => {
    const record = agent('review', { tokens: measured.tokens }, { provider: 'codex' });
    record.spend.costUsd = { source: 'unavailable', reason: 'unsupported' };
    const result = report([serializeNodeStateRecord(record)]);
    expect(result.totals.usd).toBeNull();
    expect(result.coverage.usd).toEqual({
      state: 'unknown',
      recordedNodes: 0,
      expectedNodes: 1,
      gaps: [{ path: 'review', reason: 'unsupported' }, { reason: 'total_unavailable' }],
    });
    expect(result.coverage.inputTokens.state).toBe('complete');
    expect(result.coverage.outputTokens.state).toBe('complete');
  });

  it('counts recorded zero as a contribution, not absence', () => {
    const result = report([
      serializeNodeStateRecord(agent('free', { costUsd: 0, tokens: { input: 0, output: 0 } })),
    ]);
    expect(result.totals).toEqual({ usd: 0, inputTokens: 0, outputTokens: 0 });
    expect(result.coverage.usd.state).toBe('complete');
    expect(result.coverage.usd.recordedNodes).toBe(1);
  });

  it('never fills absent run figures with selected node subtotals', () => {
    const result = report([serializeNodeStateRecord(agent('build', measured))], {});
    expect(result.totals).toEqual({ usd: null, inputTokens: null, outputTokens: null });
    for (const metric of USAGE_METRICS) {
      expect(result.coverage[metric]).toMatchObject({
        state: 'unknown',
        recordedNodes: 1,
        expectedNodes: 1,
      });
      expect(result.coverage[metric].gaps).toContainEqual({ reason: 'total_unavailable' });
    }
  });

  it('keeps a paid failed retry and the later missing measurement on one node', () => {
    const paid = agent('build', measured, { failed: true });
    const silent = agent('build');
    const result = report([serializeNodeStateRecord(paid), serializeNodeStateRecord(silent)]);
    expect(result.totals.usd).toBe(0.25);
    expect(result.coverage.usd).toMatchObject({
      state: 'partial',
      recordedNodes: 1,
      expectedNodes: 1,
    });
    expect(result.coverage.usd.gaps).toContainEqual({ path: 'build', reason: 'unknown' });
  });

  it('retains partial cost without confusing partial cache or request axes with gross tokens', () => {
    const result = report([
      serializeNodeStateRecord(
        agent('build', {
          ...measured,
          costPartial: true,
          tokens: { ...measured.tokens, cachePartial: true, callsPartial: true },
        })
      ),
    ]);
    expect(result.coverage.usd).toMatchObject({
      state: 'partial',
      recordedNodes: 1,
      expectedNodes: 1,
    });
    expect(result.coverage.usd.gaps).toEqual([{ path: 'build', reason: 'partial_measurement' }]);
    expect(result.coverage.inputTokens.state).toBe('complete');
    expect(result.coverage.outputTokens.state).toBe('complete');
  });

  it('retains explicitly incomplete token reasons and invalidates contributors to an unknown total', () => {
    const silent = agent('silent');
    silent.spend.tokens = { source: 'unavailable', reason: 'incomplete' };
    const result = report([
      serializeNodeStateRecord(agent('paid', measured)),
      serializeNodeStateRecord(silent),
    ]);
    expect(result.totals.inputTokens).toBeNull();
    expect(result.coverage.inputTokens).toMatchObject({ state: 'unknown', recordedNodes: 1 });
    expect(result.coverage.inputTokens.gaps).toContainEqual({
      path: 'silent',
      reason: 'incomplete',
    });
  });

  it('leaves pre-call attempts and replayed nodes out of the population and keeps what was paid', () => {
    const paid = serializeNodeStateRecord(agent('paid', measured));
    const notCalled = serializeNodeStateRecord(
      agent('not-called', { providerNotCalled: true }, { failed: true })
    );
    const replay: DagResumeEvent = {
      event_type: 'node_skipped_prior_success',
      step_name: 'paid',
      data: { type: 'agent', cost_usd: 999 },
    };
    const result = report([paid, notCalled, replay]);
    expect(result.totals.usd).toBe(0.25);
    expect(result.coverage.usd).toEqual({
      state: 'complete',
      recordedNodes: 1,
      expectedNodes: 1,
      gaps: [],
    });
  });

  it('proves zero-AI runs without claiming an unrecorded bill', () => {
    const deterministic = startNodeExecution({
      runId: 'run',
      path: 'script',
      node: { id: 'script', kind: 'exec', runtime: 'sh', script: 'true' },
      invocation: newNodeInvocation(),
    });
    const result = report([
      serializeNodeStateRecord(finishNodeExecution(deterministic, { status: 'completed' }, {})),
    ]);
    expect(result.totals.usd).toBeNull();
    for (const metric of USAGE_METRICS)
      expect(result.coverage[metric]).toEqual({
        state: 'not_applicable',
        recordedNodes: 0,
        expectedNodes: 0,
        gaps: [],
      });
    expect(formatUsageReport(result)).toEqual([]);
  });

  it('names an invalid recorded total on a zero-AI run instead of dropping it', () => {
    const deterministic = startNodeExecution({
      runId: 'run',
      path: 'script',
      node: { id: 'script', kind: 'exec', runtime: 'sh', script: 'true' },
      invocation: newNodeInvocation(),
    });
    const result = report(
      [serializeNodeStateRecord(finishNodeExecution(deterministic, { status: 'completed' }, {}))],
      { total_cost_usd: -1 }
    );
    expect(result.totals.usd).toBeNull();
    expect(result.coverage.usd).toEqual({
      state: 'unknown',
      recordedNodes: 0,
      expectedNodes: 0,
      gaps: [{ reason: 'total_invalid' }],
    });
    expect(result.coverage.inputTokens.state).toBe('not_applicable');
  });

  it('names an unmatched start without inventing a provider measurement', () => {
    const start = startNodeExecution({
      runId: 'run',
      path: 'in-flight',
      node: { id: 'in-flight', kind: 'agent', source: { kind: 'inline', prompt: 'p' } },
      invocation: newNodeInvocation(),
      provider: 'claude',
    });
    const result = report([serializeNodeStateRecord(start)]);
    expect(result.coverage.usd).toMatchObject({ expectedNodes: 1, recordedNodes: 0 });
    for (const metric of USAGE_METRICS)
      expect(result.coverage[metric].gaps).toEqual([
        { path: 'in-flight', reason: 'unfinished_execution' },
        { reason: 'total_unavailable' },
      ]);
    expect(formatUsageReport(result)).toEqual([
      '  Usage: cost unknown (unknown; 0/1 AI nodes recorded), input tokens unknown (unknown; 0/1 AI nodes recorded), output tokens unknown (unknown; 0/1 AI nodes recorded).',
      '    in-flight: cost, input tokens and output tokens execution has no recorded end',
      '    total was not recorded',
    ]);
  });

  it.each(['usd', 'inputTokens', 'outputTokens'] as const)(
    'refuses certification when the stored %s differs from selected spend',
    metric => {
      const metadata = { total_cost_usd: 0.25, total_tokens_in: 4, total_tokens_out: 2 };
      const fields = {
        usd: 'total_cost_usd',
        inputTokens: 'total_tokens_in',
        outputTokens: 'total_tokens_out',
      } as const;
      metadata[fields[metric]] += 1;
      const result = report([serializeNodeStateRecord(agent('build', measured))], metadata);
      expect(result.coverage[metric].state).toBe('unknown');
      expect(result.coverage[metric].gaps).toContainEqual({ reason: 'total_mismatch' });
    }
  );

  it('accepts only the existing floating cost tolerance', () => {
    const result = report([serializeNodeStateRecord(agent('build', measured))], {
      total_cost_usd: 0.25000000001,
      total_tokens_in: 4,
      total_tokens_out: 2,
    });
    expect(result.coverage.usd.state).toBe('complete');
  });

  it('distinguishes absent history, unknown graph kind and unsourced historical measurements', () => {
    const absent = report([]);
    expect(absent.coverage.usd.gaps).toEqual([
      { reason: 'history_absent' },
      { reason: 'total_unavailable' },
    ]);
    const graph = report([], { terminal_graph: { node_ids: ['unknown'] } });
    expect(graph.coverage.usd.expectedNodes).toBeNull();
    expect(graph.coverage.usd.gaps).toEqual([
      { path: 'unknown', reason: 'node_kind_unavailable' },
      { reason: 'history_absent' },
      { reason: 'total_unavailable' },
    ]);
    const legacy = report([
      {
        event_type: 'node_completed',
        step_name: 'old',
        data: { type: 'agent', cost_usd: 0.25, tokens: measured.tokens },
      },
    ]);
    expect(legacy.totals.usd).toBe(0.25);
    expect(legacy.coverage.usd.state).not.toBe('complete');
    // The node is known to have executed; only where its figure came from is not.
    expect(legacy.coverage.usd).toMatchObject({ recordedNodes: 1, expectedNodes: 1 });
    expect(legacy.coverage.usd.gaps).toContainEqual({
      path: 'old',
      reason: 'measurement_source_absent',
    });
  });

  it('keeps two gaps on one node apart when their reasons differ', () => {
    const record = agent('review');
    record.spend.costUsd = { source: 'unavailable', reason: 'unsupported' };
    record.spend.tokens = { source: 'unavailable', reason: 'not_reported' };
    const result = report([serializeNodeStateRecord(record)]);
    expect(result.coverage.usd.gaps).toContainEqual({ path: 'review', reason: 'unsupported' });
    expect(result.coverage.inputTokens.gaps).toContainEqual({
      path: 'review',
      reason: 'not_reported',
    });
    const lines = formatUsageReport(result);
    expect(lines).toContain('    review: cost not recorded (unsupported)');
    expect(lines).toContain('    review: input tokens and output tokens not reported');
    expect(lines).toHaveLength(4);
  });

  it('does not close a start with an end that was recorded before it', () => {
    const earlier: DagResumeEvent = {
      event_type: 'node_completed',
      step_name: 'build',
      data: { type: 'agent', cost_usd: 0.25, tokens: measured.tokens },
    };
    const rerun: DagResumeEvent = {
      event_type: 'node_started',
      step_name: 'build',
      data: { type: 'agent' },
    };
    const result = report([earlier, rerun]);
    expect(result.coverage.usd.gaps).toContainEqual({
      path: 'build',
      reason: 'unfinished_execution',
    });
  });

  it('does not call equal figures contradictory when only a partial flag differs', () => {
    const record = agent('build', measured);
    const floored = finishNodeExecution(
      record,
      { status: 'completed' },
      { ...measured, costPartial: true }
    );
    const result = report([serializeNodeStateRecord(record), serializeNodeStateRecord(floored)]);
    expect(result.totals.usd).toBe(0.5);
    expect(result.coverage.usd.gaps.filter(gap => gap.reason === 'record_unreadable')).toEqual([]);
    expect(result.coverage.inputTokens).toMatchObject({ state: 'complete', recordedNodes: 1 });
  });

  it('leaves an amendment out of the comparison of one attempt\u2019s terminals', () => {
    const record = agent('build', measured);
    const amendment = finishNodeExecution(
      { ...record, accounting: 'amendment' },
      { status: 'failed', error: 'contract' },
      {}
    );
    expect(amendment.attempt.id).toBe(record.attempt.id);
    const result = report([serializeNodeStateRecord(record), serializeNodeStateRecord(amendment)]);
    expect(result.coverage.usd).toMatchObject({ state: 'complete', recordedNodes: 1 });
  });

  it('counts a child\u2019s AI nodes as the child counted them', () => {
    const leaf = serializeNodeStateRecord(agent('fan__item__build', measured));
    const wrapper: DagResumeEvent = {
      event_type: 'node_completed',
      step_name: 'fan__item',
      data: {
        type: 'compose_fan_out_instance',
        cost_scope: 'total',
        cost_usd: 0.25,
        cost_partial: true,
        tokens: measured.tokens,
      },
    };
    const childFold = foldDagUsage([leaf, wrapper], 'child');
    const child = collectRunUsageEvidence(
      { id: 'child', metadata: serializeRunUsage(countedUsage(childFold)) },
      childFold
    );
    const parent: DagResumeEvent = {
      event_type: 'node_completed',
      step_name: 'children',
      data: {
        type: 'workflow',
        cost_usd: 0.25,
        tokens: measured.tokens,
        child_usage: [{ childRunId: 'child', costUsd: 0.25, tokens: measured.tokens }],
      },
    };
    const result = buildRunUsageReport(
      { id: 'run', metadata: serializeRunUsage(countedUsage(foldDagUsage([parent], 'run'))) },
      foldDagUsage([parent], 'run'),
      { children: new Map([['child', { evidence: child }]]) }
    );
    expect(result.coverage.usd).toMatchObject({
      recordedNodes: 1,
      expectedNodes: 1,
      state: 'partial',
    });
    expect(result.coverage.usd.gaps).toContainEqual({
      runId: 'child',
      path: 'fan__item',
      reason: 'partial_measurement',
    });
  });

  it('keeps a child attributable under an instance terminal that reconciles with its leaf', () => {
    const leaf: DagResumeEvent = {
      event_type: 'node_completed',
      step_name: 'fan__item__children',
      data: {
        type: 'workflow',
        cost_usd: 0.25,
        tokens: measured.tokens,
        child_usage: [{ childRunId: 'child', costUsd: 0.25, tokens: measured.tokens }],
      },
    };
    const wrapper: DagResumeEvent = {
      event_type: 'node_completed',
      step_name: 'fan__item',
      data: {
        type: 'compose_fan_out_instance',
        cost_scope: 'total',
        cost_usd: 0.25,
        tokens: measured.tokens,
      },
    };
    const childFold = foldDagUsage([serializeNodeStateRecord(agent('build', measured))], 'child');
    const child = collectRunUsageEvidence(
      { id: 'child', metadata: serializeRunUsage(countedUsage(childFold)) },
      childFold
    );
    const result = buildRunUsageReport(
      {
        id: 'run',
        metadata: serializeRunUsage(countedUsage(foldDagUsage([leaf, wrapper], 'run'))),
      },
      foldDagUsage([leaf, wrapper], 'run'),
      { children: new Map([['child', { evidence: child }]]) }
    );
    expect(result.coverage.usd).toEqual({
      state: 'complete',
      recordedNodes: 1,
      expectedNodes: 1,
      gaps: [],
    });
  });

  it('lets a node limitation explain a partial wrapper instead of listing both', () => {
    const leaf = serializeNodeStateRecord(agent('fan__item__build', measured));
    const wrapper: DagResumeEvent = {
      event_type: 'node_completed',
      step_name: 'fan__item',
      data: {
        type: 'compose_fan_out_instance',
        cost_scope: 'total',
        cost_usd: 5,
        cost_partial: true,
        tokens: { input: 30, output: 10 },
      },
    };
    const result = report([leaf, wrapper]);
    expect(result.coverage.usd.gaps.filter(gap => gap.path === 'fan__item')).toEqual([
      { path: 'fan__item', reason: 'scope_unattributed' },
    ]);
  });

  it('keeps numerical duplicate-terminal behavior but marks contradictory evidence unreadable', () => {
    const record = agent('duplicate', measured);
    const changed = {
      ...record,
      spend: { ...record.spend, costUsd: { source: 'provider' as const, value: 0.5 } },
    };
    const result = report([serializeNodeStateRecord(record), serializeNodeStateRecord(changed)]);
    expect(result.totals.usd).toBe(0.75);
    expect(result.coverage.usd.recordedNodes).toBe(1);
    expect(result.coverage.usd.state).not.toBe('complete');
    expect(result.coverage.usd.gaps).toContainEqual({
      path: 'duplicate',
      reason: 'record_unreadable',
    });
  });

  it('uses authoritative instance segments once and certifies matching leaf attribution', () => {
    const leaf = serializeNodeStateRecord(agent('fan__item__build', measured));
    const wrapper: DagResumeEvent = {
      event_type: 'node_completed',
      step_name: 'fan__item',
      data: {
        type: 'compose_fan_out_instance',
        cost_scope: 'total',
        cost_usd: 0.25,
        tokens: measured.tokens,
      },
    };
    const result = report([leaf, wrapper]);
    expect(result.totals.usd).toBe(0.25);
    expect(result.coverage.usd).toEqual({
      state: 'complete',
      recordedNodes: 1,
      expectedNodes: 1,
      gaps: [],
    });
  });

  it('keeps a selected instance wrapper partial-cost flag on USD only', () => {
    const leaf = serializeNodeStateRecord(agent('fan__item__build', measured));
    const wrapper: DagResumeEvent = {
      event_type: 'node_completed',
      step_name: 'fan__item',
      data: {
        type: 'compose_fan_out_instance',
        cost_scope: 'total',
        cost_usd: 0.25,
        cost_partial: true,
        tokens: measured.tokens,
      },
    };
    const result = report([leaf, wrapper]);
    expect(result.coverage.usd).toEqual({
      state: 'partial',
      recordedNodes: 1,
      expectedNodes: 1,
      gaps: [{ path: 'fan__item', reason: 'partial_measurement' }],
    });
    expect(result.coverage.inputTokens.state).toBe('complete');
    expect(result.coverage.outputTokens.state).toBe('complete');
  });

  it('keeps an opaque instance amount without allocating it to readable leaves', () => {
    const leaf = serializeNodeStateRecord(agent('fan__item__build', measured));
    const wrapper: DagResumeEvent = {
      event_type: 'node_completed',
      step_name: 'fan__item',
      data: {
        type: 'compose_fan_out_instance',
        cost_scope: 'total',
        cost_usd: 5,
        tokens: { input: 30, output: 10 },
      },
    };
    const later = serializeNodeStateRecord(agent('fan__item__later', measured));
    const result = report([leaf, wrapper, later]);
    expect(result.totals.usd).toBe(5.25);
    expect(result.coverage.usd).toMatchObject({
      state: 'partial',
      recordedNodes: 2,
      expectedNodes: null,
    });
    expect(result.coverage.usd.gaps).toContainEqual({
      path: 'fan__item',
      reason: 'scope_unattributed',
    });
  });

  it('counts provider-backed loop continuations without inventing deferred provider or attempt identity', () => {
    const start = startNodeExecution({
      runId: 'run',
      path: 'loop',
      node: {
        id: 'loop',
        kind: 'loop',
        loop: { prompt: 'p', until: 'DONE', max_iterations: 2, fresh_context: false },
      },
      invocation: newNodeInvocation(),
      provider: 'claude',
    });
    const failed = finishNodeExecution(
      start,
      { status: 'failed', error: 'config', failureKind: 'config' },
      { costUsd: 0.25, tokens: { input: 2, output: 1 }, costPartial: true }
    );
    const deferred = serializeDeferredNodeUsage(
      finishNodeExecution(
        start,
        { status: 'suspended', point: 'interactive_loop' },
        { costUsd: 0.5, tokens: { input: 3, output: 2 } }
      )
    );
    const result = report([serializeNodeStateRecord(failed), deferred]);
    expect(result.totals).toEqual({ usd: 0.5, inputTokens: 3, outputTokens: 2 });
    expect(result.coverage.usd).toEqual({
      state: 'complete',
      recordedNodes: 1,
      expectedNodes: 1,
      gaps: [],
    });
  });

  it('does not let an aggregate amendment create another consumption gap', () => {
    const record = agent('build', measured);
    const amendment = finishNodeExecution(
      { ...record, accounting: 'amendment' },
      { status: 'failed', error: 'contract' },
      {}
    );
    const result = report([serializeNodeStateRecord(record), serializeNodeStateRecord(amendment)]);
    expect(result.totals).toEqual({ usd: 0.25, inputTokens: 4, outputTokens: 2 });
    expect(result.coverage.usd).toEqual({
      state: 'complete',
      recordedNodes: 1,
      expectedNodes: 1,
      gaps: [],
    });
  });

  it('retains partial carried-baseline measurement evidence alongside a deferred loop increment', () => {
    const start = startNodeExecution({
      runId: 'run',
      path: 'loop',
      node: {
        id: 'loop',
        kind: 'loop',
        loop: { prompt: 'p', until: 'DONE', max_iterations: 2, fresh_context: false },
      },
      invocation: newNodeInvocation(),
      provider: 'claude',
    });
    const baseline = finishNodeExecution(
      start,
      { status: 'failed', error: 'config', failureKind: 'config' },
      { costUsd: 0.25, tokens: { input: 2, output: 1 }, costPartial: true }
    );
    const deferred = serializeDeferredNodeUsage(
      finishNodeExecution(
        start,
        { status: 'suspended', point: 'interactive_loop' },
        { costUsd: 0.5, tokens: { input: 3, output: 2 } }
      ),
      baseline.spend
    );
    const result = report([serializeNodeStateRecord(baseline), deferred]);
    expect(result.totals).toEqual({ usd: 0.75, inputTokens: 5, outputTokens: 3 });
    expect(result.coverage.usd).toMatchObject({
      state: 'partial',
      recordedNodes: 1,
      expectedNodes: 1,
      gaps: [{ path: 'loop', reason: 'partial_measurement' }],
    });
    expect(result.coverage.inputTokens.state).toBe('complete');
  });

  it('does not exclude paid loop work when its approval gate is skipped after execution', () => {
    const start = startNodeExecution({
      runId: 'run',
      path: 'loop',
      node: {
        id: 'loop',
        kind: 'loop',
        loop: { prompt: 'p', until: 'DONE', max_iterations: 2, fresh_context: false },
      },
      invocation: newNodeInvocation(),
      provider: 'claude',
    });
    const skipped = finishNodeExecution(
      start,
      {
        status: 'skipped',
        reason: 'trigger_rule',
        cause: { kind: 'upstream_failed', origin: 'peer' },
      },
      { costUsd: 0.25, tokens: { input: 4, output: 2 } }
    );
    const result = report([
      serializeNodeStateRecord(start),
      serializeDeferredNodeUsage(skipped),
      serializeNodeStateRecord(skipped),
    ]);
    expect(result.coverage.usd).toEqual({
      state: 'complete',
      recordedNodes: 1,
      expectedNodes: 1,
      gaps: [],
    });
  });
});
