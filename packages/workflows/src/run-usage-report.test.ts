import { describe, expect, it } from 'bun:test';
import { countedUsage, foldDagUsage } from './dag-usage-fold';
import { finishNodeExecution, newNodeInvocation, startNodeExecution } from './node-execution';
import { serializeNodeStateRecord, serializeDeferredNodeUsage } from './node-record-serialization';
import {
  aggregateUsageReports,
  buildRunUsageReport,
  formatUsageReport,
  itemRunUsageReport,
} from './run-usage-report';
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
  it('certifies every metric from actual execution evidence and preserves only usage identities', () => {
    const record = agent('build', { ...measured, output: { text: 'PRIVATE_OUTPUT' } });
    const result = report([serializeNodeStateRecord(record)]);
    expect(result.totals).toEqual({ usd: 0.25, inputTokens: 4, outputTokens: 2 });
    for (const metric of USAGE_METRICS) {
      expect(result.coverage[metric]).toMatchObject({
        state: 'complete',
        aiNodes: 1,
        observedAiNodes: 1,
        contributedAiNodes: 1,
        gaps: [],
        limitations: [],
      });
      expect(result.coverage[metric].contributors).toEqual([
        {
          runId: 'run',
          path: 'build',
          nodeKind: 'agent',
          provider: 'claude',
          invocationId: record.invocation.id,
          attemptId: record.attempt.id,
          loopPath: [{ groupId: 'rounds', iteration: 2 }],
        },
      ]);
    }
    expect(runUsageReportSchema.parse(result)).toEqual(result);
    const json = JSON.stringify(result);
    for (const marker of ['PRIVATE_PROMPT', 'PRIVATE_OUTPUT', 'PRIVATE_SESSION', 'PRIVATE_ERROR'])
      expect(json).not.toContain(marker);
    expect(formatUsageReport(result).join('\n')).not.toContain('completeness unknown');
  });

  it('separates unsupported cost from complete gross-token coverage', () => {
    const record = agent('review', { tokens: measured.tokens }, { provider: 'codex' });
    record.spend.costUsd = { source: 'unavailable', reason: 'unsupported' };
    const result = report([serializeNodeStateRecord(record)]);
    expect(result.totals.usd).toBeNull();
    expect(result.coverage.usd).toMatchObject({
      state: 'unknown',
      aiNodes: 1,
      contributedAiNodes: 0,
      gaps: [{ runId: 'run', path: 'review', source: 'node', reason: 'unsupported' }],
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
    expect(result.coverage.usd.contributedAiNodes).toBe(1);
  });

  it('never fills absent run figures with selected node subtotals', () => {
    const result = report([serializeNodeStateRecord(agent('build', measured))], {});
    expect(result.totals).toEqual({ usd: null, inputTokens: null, outputTokens: null });
    for (const metric of USAGE_METRICS) {
      expect(result.coverage[metric].state).toBe('unknown');
      expect(result.coverage[metric].contributedAiNodes).toBe(0);
      expect(result.coverage[metric].recordedNodes).toHaveLength(1);
      expect(result.coverage[metric].limitations).toContainEqual({
        runId: 'run',
        reason: 'total_unavailable',
      });
    }
  });

  it('keeps a paid failed retry and the later missing measurement on one node', () => {
    const paid = agent('build', measured, { failed: true });
    const silent = agent('build');
    const result = report([serializeNodeStateRecord(paid), serializeNodeStateRecord(silent)]);
    expect(result.totals.usd).toBe(0.25);
    expect(result.coverage.usd).toMatchObject({
      state: 'partial',
      aiNodes: 1,
      contributedAiNodes: 1,
    });
    expect(result.coverage.usd.gaps).toContainEqual(
      expect.objectContaining({
        path: 'build',
        attemptId: silent.attempt.id,
        source: 'node',
        reason: 'unknown',
      })
    );
    expect(result.coverage.usd.contributors[0].attemptId).toBe(paid.attempt.id);
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
    expect(result.coverage.usd.state).toBe('partial');
    expect(result.coverage.usd.partial).toHaveLength(1);
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
    expect(result.coverage.inputTokens.contributedAiNodes).toBe(0);
    expect(result.coverage.inputTokens.recordedNodes).toHaveLength(1);
    expect(result.coverage.inputTokens.gaps).toContainEqual(
      expect.objectContaining({ source: 'node', reason: 'incomplete', path: 'silent' })
    );
  });

  it('excludes pre-call attempts and replayed nodes without erasing the earlier consumption', () => {
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
    expect(result.coverage.usd).toMatchObject({
      aiNodes: 1,
      contributedAiNodes: 1,
      state: 'complete',
    });
    expect(result.coverage.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'paid', reason: 'replayed' }),
        expect.objectContaining({
          path: 'not-called',
          reason: 'not_applicable',
          costReason: 'not_applicable',
        }),
      ])
    );
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
      expect(result.coverage[metric]).toMatchObject({
        state: 'not_applicable',
        aiNodes: 0,
        contributedAiNodes: 0,
      });
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
    expect(result.coverage.usd.aiNodes).toBe(1);
    expect(result.coverage.usd.gaps).toContainEqual(
      expect.objectContaining({
        source: 'coverage',
        reason: 'unfinished_execution',
        path: 'in-flight',
      })
    );
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
      expect(result.coverage[metric].contributedAiNodes).toBe(0);
      expect(result.coverage[metric].limitations).toContainEqual({
        runId: 'run',
        reason: 'total_mismatch',
      });
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
    expect(report([]).coverage.usd.limitations).toContainEqual({
      runId: 'run',
      reason: 'history_absent',
    });
    const graph = report([], { terminal_graph: { node_ids: ['unknown'] } });
    expect(graph.coverage.usd.aiNodes).toBeNull();
    expect(graph.coverage.usd.limitations).toContainEqual({
      runId: 'run',
      path: 'unknown',
      reason: 'node_kind_unavailable',
    });
    const legacy = report([
      {
        event_type: 'node_completed',
        step_name: 'old',
        data: { type: 'agent', cost_usd: 0.25, tokens: measured.tokens },
      },
    ]);
    expect(legacy.totals.usd).toBe(0.25);
    expect(legacy.coverage.usd.state).not.toBe('complete');
    expect(legacy.coverage.usd.gaps).toContainEqual({
      runId: 'run',
      path: 'old',
      nodeKind: 'agent',
      source: 'coverage',
      reason: 'measurement_source_absent',
    });
  });

  it('keeps numerical duplicate-terminal behavior but marks contradictory evidence unreadable', () => {
    const record = agent('duplicate', measured);
    const changed = {
      ...record,
      spend: { ...record.spend, costUsd: { source: 'provider' as const, value: 0.5 } },
    };
    const result = report([serializeNodeStateRecord(record), serializeNodeStateRecord(changed)]);
    expect(result.totals.usd).toBe(0.75);
    expect(result.coverage.usd.contributedAiNodes).toBe(1);
    expect(result.coverage.usd.state).not.toBe('complete');
    expect(result.coverage.usd.limitations).toContainEqual({
      runId: 'run',
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
    expect(result.coverage.usd).toMatchObject({
      state: 'complete',
      aiNodes: 1,
      contributedAiNodes: 1,
    });
    expect(result.coverage.usd.contributors[0].path).toBe('fan__item__build');
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
      aiNodes: null,
      observedAiNodes: 2,
      contributedAiNodes: 1,
    });
    expect(result.coverage.usd.contributors[0].path).toBe('fan__item__later');
    expect(result.coverage.usd.limitations).toContainEqual({
      runId: 'run',
      path: 'fan__item',
      reason: 'scope_unattributed',
    });
  });

  it('aggregates recorded own-run figures and qualifies shared node names by run', () => {
    const first = report([serializeNodeStateRecord(agent('build', measured))]);
    const secondFold = foldDagUsage(
      [serializeNodeStateRecord(agent('build', measured, { runId: 'other' }))],
      'other'
    );
    const second = buildRunUsageReport(
      { id: 'other', metadata: serializeRunUsage(countedUsage(secondFold)) },
      secondFold
    );
    const result = aggregateUsageReports([first, second]);
    expect(result.totals).toEqual({ usd: 0.5, inputTokens: 8, outputTokens: 4 });
    expect(result.coverage.usd).toMatchObject({
      state: 'complete',
      aiNodes: 2,
      contributedAiNodes: 2,
    });
    expect(result.coverage.usd.contributors.map(node => node.runId)).toEqual(['run', 'other']);
  });

  it('makes an unreadable own run a partial sum and retains token uncertainty', () => {
    const first = report([serializeNodeStateRecord(agent('build', measured))]);
    const result = aggregateUsageReports([first], {
      missingRunIds: ['deleted'],
      unknownTokens: true,
    });
    expect(result.totals).toEqual({ usd: 0.25, inputTokens: null, outputTokens: null });
    expect(result.coverage.usd.state).toBe('partial');
    expect(result.coverage.usd.aiNodes).toBeNull();
    expect(result.coverage.inputTokens.contributedAiNodes).toBe(0);
    expect(result.coverage.usd.limitations).toContainEqual({
      runId: 'deleted',
      reason: 'history_unavailable',
    });
  });

  it('preserves malformed historical per-run values while excluding them from the aggregate', () => {
    const fold = foldDagUsage([], 'run');
    const run = {
      id: 'run',
      metadata: { total_cost_usd: -1, total_tokens_in: -2, total_tokens_out: 1.5 },
    };
    const result = itemRunUsageReport(run, buildRunUsageReport(run, fold));
    expect(result.totals).toEqual({ usd: -1, inputTokens: -2, outputTokens: 1.5 });
    expect(aggregateUsageReports([result]).totals).toEqual({
      usd: null,
      inputTokens: null,
      outputTokens: null,
    });
    for (const metric of USAGE_METRICS)
      expect(result.coverage[metric].limitations).toContainEqual({
        runId: 'run',
        reason: 'total_invalid',
      });
  });

  it('reports an item without runs as not applicable, not a fabricated zero', () => {
    const result = aggregateUsageReports([]);
    expect(result.totals).toEqual({ usd: null, inputTokens: null, outputTokens: null });
    expect(result.coverage.usd).toMatchObject({ state: 'not_applicable', aiNodes: 0 });
  });

  it('pairs item coverage with its historical joint-token projection rather than a single readable axis', () => {
    const fold = foldDagUsage([serializeNodeStateRecord(agent('build', measured))], 'run');
    const run = { id: 'run', metadata: { total_cost_usd: 0.25, total_tokens_in: 4 } };
    const result = itemRunUsageReport(run, buildRunUsageReport(run, fold));
    expect(result.totals.inputTokens).toBeNull();
    expect(result.coverage.inputTokens).toMatchObject({
      state: 'unknown',
      contributedAiNodes: 0,
      contributors: [],
    });
    expect(result.coverage.inputTokens.recordedNodes).toHaveLength(1);
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
    expect(result.coverage.usd).toMatchObject({
      state: 'complete',
      aiNodes: 1,
      contributedAiNodes: 1,
      gaps: [],
      partial: [],
    });
    expect(result.coverage.usd.contributors[0].provider).toBeUndefined();
    expect(result.coverage.usd.contributors[0].attemptId).toBeUndefined();
    expect(result.coverage.usd.contributors[0].invocationId).toBe(start.invocation.id);
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
    expect(result.coverage.usd).toMatchObject({
      state: 'complete',
      aiNodes: 1,
      contributedAiNodes: 1,
      gaps: [],
    });
  });
});
