import { describe, test, expect } from 'bun:test';
import {
  buildRunLog,
  countLogMessages,
  foldSections,
  pairProviderToolCalls,
  quietFoldSummary,
  visibleRunLog,
  type BlindEntry,
  type LogSection,
  type RunLog,
} from './run-log';
import type { ProviderEventRecord, RunProviderEvents } from './provider-events';
import { mergeProviderEventRecords } from './provider-events';
import type { Message } from '../primitives/message';
import type { NodeRun } from '../primitives/event';

function record(
  stepName: string,
  attemptId: string | null,
  seq: number,
  observedAt: string,
  event: ProviderEventRecord['event']
): ProviderEventRecord {
  return { runId: 'r1', stepName, attemptId, seq, observedAt, event };
}

const T = '2026-10-02T10:00:00.000Z';

function nodeRun(nodeId: string, startedAt: string, over: Partial<NodeRun> = {}): NodeRun {
  return {
    nodeId,
    nodeName: nodeId,
    status: 'completed',
    startedAt,
    endedAt: null,
    durationMs: 60_000,
    costUsd: null,
    costPartial: false,
    costScope: null,
    numTurns: null,
    tokens: null,
    stopReason: null,
    skipReason: null,
    skipExpr: null,
    output: null,
    error: null,
    failureKind: null,
    fanOutOutcome: undefined,
    ...over,
  };
}

function message(id: string, timestamp: string, over: Partial<Message> = {}): Message {
  return {
    id,
    role: 'assistant',
    content: `text of ${id}`,
    timestamp,
    toolCalls: [],
    error: null,
    category: null,
    dispatch: null,
    workflowResult: null,
    ...over,
  };
}

const text = (seq: number, value: string, attempt = 'a1'): ProviderEventRecord =>
  record('implement', attempt, seq, T, { type: 'agent_message_chunk', text: value });
const tool = (seq: number, name: string, attempt = 'a1'): ProviderEventRecord =>
  record('implement', attempt, seq, T, {
    type: 'tool_call',
    toolCallId: `${attempt}-${name}`,
    name,
  });

/** Each turn as its text followed by what it holds, e.g. `A: t1 t2`. */
function outline(section: LogSection | undefined): string[] {
  return (section?.turns ?? []).map(
    turn =>
      `${turn.text?.text ?? '-'}: ${turn.items
        .map(item =>
          item.kind === 'tool' ? item.call.name : item.kind === 'hook' ? 'hook' : item.message
        )
        .join(' ')}`
  );
}

const kinds = (entries: readonly BlindEntry[]): string[] =>
  entries.map(entry => `${entry.kind}:${entry.key}`);

function build(
  providerEvents: RunProviderEvents,
  over: { messages?: Message[]; nodeRuns?: NodeRun[] } = {}
): RunLog {
  return buildRunLog({
    messages: over.messages ?? [],
    events: [],
    nodeRuns: over.nodeRuns ?? [nodeRun('implement', '2026-10-02T09:59:00.000Z')],
    providerEvents,
  });
}

describe('pairProviderToolCalls', () => {
  test('pairs two concurrent calls of one tool by id, not by name or order', () => {
    const events: RunProviderEvents = new Map([
      [
        'implement',
        [
          record('implement', 'a1', 0, '2026-10-02T10:00:00.000Z', {
            type: 'tool_call',
            toolCallId: 'x',
            name: 'Bash',
            rawInput: { command: 'sleep 2' },
          }),
          record('implement', 'a1', 1, '2026-10-02T10:00:00.010Z', {
            type: 'tool_call',
            toolCallId: 'y',
            name: 'Bash',
            rawInput: { command: 'ls' },
          }),
          record('implement', 'a1', 2, '2026-10-02T10:00:00.050Z', {
            type: 'tool_call_update',
            toolCallId: 'y',
            status: 'completed',
            output: 'a.ts',
          }),
          record('implement', 'a1', 3, '2026-10-02T10:00:02.000Z', {
            type: 'tool_call_update',
            toolCallId: 'x',
            status: 'failed',
            output: 'x'.repeat(16_384),
            outputTruncated: true,
            exitCode: 1,
          }),
        ],
      ],
    ]);

    const paired = pairProviderToolCalls(events);

    expect(paired.map(p => [p.nodeId, p.call])).toEqual([
      [
        'implement',
        {
          name: 'Bash',
          input: { command: 'sleep 2' },
          status: 'failed',
          output: 'x'.repeat(16_384),
          outputTruncated: true,
          exitCode: 1,
          durationMs: 2000,
        },
      ],
      [
        'implement',
        {
          name: 'Bash',
          input: { command: 'ls' },
          status: 'completed',
          output: 'a.ts',
          durationMs: 40,
        },
      ],
    ]);
  });

  test('a legacy record pairs within its own null attempt, and a title names the call', () => {
    const events: RunProviderEvents = new Map([
      [
        'plan',
        [
          record('plan', null, 0, '2026-10-02T10:00:00.000Z', {
            type: 'tool_call',
            toolCallId: 'anonymous-1',
            name: 'command_execution',
            title: 'git status',
          }),
          record('plan', null, 1, '2026-10-02T10:00:01.000Z', {
            type: 'tool_call_update',
            toolCallId: 'anonymous-1',
            status: 'cancelled',
          }),
          // A retry's call with the same id is its own call.
          record('plan', 'a2', 0, '2026-10-02T10:00:05.000Z', {
            type: 'tool_call',
            toolCallId: 'anonymous-1',
            name: 'Read',
          }),
        ],
      ],
    ]);

    expect(
      pairProviderToolCalls(events).map(p => [p.call.name, p.call.status, p.call.durationMs])
    ).toEqual([
      // A legacy row's time is too coarse to time the call.
      ['git status', 'cancelled', undefined],
      ['Read', undefined, undefined],
    ]);
  });
});

describe('a node section follows the recorded order', () => {
  test('each tool call sits under the text recorded before it, whatever the clock says', () => {
    const records = [
      tool(0, 't0'),
      text(1, 'A'),
      tool(2, 't1'),
      record('implement', 'a1', 3, T, {
        type: 'tool_call_update',
        toolCallId: 'a1-t1',
        status: 'completed',
      }),
      tool(4, 't2'),
      text(5, 'B'),
      tool(6, 't3'),
    ];
    const log = build(new Map([['implement', mergeProviderEventRecords([], records, 'load')]]));
    expect(outline(log.sections[0])).toEqual(['-: t0', 'A: t1 t2', 'B: t3']);
    expect(log.toolCallCount).toBe(4);
  });

  test("a retry's records follow the first attempt's", () => {
    const records = [text(0, 'second', 'a2'), tool(1, 't2', 'a2')];
    const held = mergeProviderEventRecords([], [text(0, 'first'), tool(1, 't1')], 'load');
    const log = build(new Map([['implement', mergeProviderEventRecords(held, records, 'after')]]));
    expect(outline(log.sections[0])).toEqual(['first: t1', 'second: t2']);
  });

  test('a continuation appends to the reply a warning split, and the warning stays in its turn', () => {
    const records = [
      text(0, 'Half a ', 'a1'),
      record('implement', 'a1', 1, T, { type: 'warning', code: 'x.y', message: 'slow down' }),
      record('implement', 'a1', 2, T, {
        type: 'agent_message_chunk',
        text: 'sentence.',
        continuesPreviousBlock: true,
      }),
      tool(3, 't1'),
    ];
    expect(outline(build(new Map([['implement', records]])).sections[0])).toEqual([
      'Half a sentence.: slow down t1',
    ]);
  });

  test('whitespace-only text opens no card, and the events that are not shown open no turn', () => {
    const records = [
      text(0, ' \n'),
      record('implement', 'a1', 1, T, { type: 'agent_thought_chunk', text: 'hmm' }),
    ];
    const log = build(new Map([['implement', records]]));
    expect(log.sections[0]?.turns).toEqual([]);
    expect(countLogMessages(log)).toBe(0);
  });

  test('a step whose node state has not arrived is a section of its own, after the nodes', () => {
    const log = build(
      new Map([
        ['implement', [text(0, 'A')]],
        ['review', [record('review', 'a1', 0, T, { type: 'agent_message_chunk', text: 'R' })]],
      ])
    );
    expect(log.sections.map(section => [section.stepName, section.node?.nodeId ?? null])).toEqual([
      ['implement', 'implement'],
      ['review', null],
    ]);
  });
});

describe('conversation messages are placed between nodes, never against a tool call', () => {
  const nodeRuns = [
    nodeRun('plan', '2026-10-02T10:00:00.000Z'),
    nodeRun('implement', '2026-10-02T10:05:00.000Z'),
  ];
  const messages = [
    message('before', '2026-10-02T09:59:00.000Z', { role: 'user' }),
    message('copy', '2026-10-02T10:00:30.000Z'),
    message('answer', '2026-10-02T10:06:00.000Z', { role: 'user' }),
    message('empty', '2026-10-02T10:06:30.000Z', {
      content: '',
      toolCalls: [{ name: 'InlineOnly', input: {} }],
    }),
  ];

  test('with recorded text, an assistant message is the copy of it and sits behind System', () => {
    const log = build(
      new Map([['plan', [record('plan', 'a1', 0, T, { type: 'agent_message_chunk', text: 'A' })]]]),
      {
        messages,
        nodeRuns,
      }
    );
    expect(log.recordedText).toBe(true);
    expect(kinds(log.leading)).toEqual(['message:m:before']);
    expect(kinds(log.sections[0]?.trailing ?? [])).toEqual(['conversation_copy:m:copy']);
    // No provider tool call was recorded, so the message-inline one is the only record of it.
    expect(kinds(log.sections[1]?.trailing ?? [])).toEqual(['message:m:answer', 'tool:t:empty:0']);
    // The recorded block and the two user messages; the copy is not counted twice.
    expect(countLogMessages(log)).toBe(3);

    const quiet = visibleRunLog(log, {
      showToolCalls: true,
      showSystem: false,
      selectedNodeId: null,
    });
    expect(kinds(quiet.sections[0]?.trailing ?? [])).toEqual([]);
    const loud = visibleRunLog(log, {
      showToolCalls: true,
      showSystem: true,
      selectedNodeId: null,
    });
    expect(kinds(loud.sections[0]?.trailing ?? [])).toEqual(['conversation_copy:m:copy']);
  });

  test('without recorded text the message is the text, and an empty one is only a System row', () => {
    const log = build(
      new Map([
        [
          'plan',
          [record('plan', null, 0, T, { type: 'tool_call', toolCallId: 'x', name: 'Grep' })],
        ],
      ]),
      {
        messages,
        nodeRuns,
      }
    );
    expect(log.recordedText).toBe(false);
    expect(kinds(log.sections[0]?.trailing ?? [])).toEqual(['message:m:copy']);
    // Provider events hold the run's tool calls, so the inline copy is not shown.
    expect(kinds(log.sections[1]?.trailing ?? [])).toEqual([
      'message:m:answer',
      'system_row:sm:noise:empty',
    ]);
    expect(countLogMessages(log)).toBe(3);
  });

  test('a selected node keeps its own section and what is slotted after it', () => {
    const log = build(new Map(), { messages, nodeRuns });
    const selected = visibleRunLog(log, {
      showToolCalls: false,
      showSystem: false,
      selectedNodeId: 'implement',
    });
    expect(selected.leading).toEqual([]);
    expect(selected.sections.map(section => section.stepName)).toEqual(['implement']);
    expect(kinds(selected.sections[0]?.trailing ?? [])).toEqual(['message:m:answer']);
  });
});

describe('foldSections', () => {
  const section = (id: string, over: Partial<NodeRun> = {}, extra: Partial<LogSection> = {}) => ({
    node: nodeRun(id, T, { durationMs: 1200, ...over }),
    stepName: id,
    turns: [],
    trailing: [],
    ...extra,
  });
  const shape = (sections: LogSection[]): (string | string[])[] =>
    foldSections(sections).map(item =>
      'fold' in item ? item.fold.map(folded => folded.stepName) : item.stepName
    );

  test('folds a run of skipped and under-five-second nodes, and counts each kind', () => {
    const sections = [
      section('start'),
      section('blocked', { status: 'skipped', durationMs: null }),
      section('pick', { durationMs: 4999 }),
      section('build', { durationMs: 5000 }),
      section('lonely'),
    ];
    expect(shape(sections)).toEqual([['start', 'blocked', 'pick'], 'build', 'lonely']);
    const [fold] = foldSections(sections);
    expect(
      fold !== undefined && 'fold' in fold ? [fold.key, quietFoldSummary(fold.fold)] : null
    ).toEqual(['start', '3 steps · 2 done in under 5 s · 1 skipped']);
    expect(quietFoldSummary([section('a'), section('b')])).toBe('2 steps · 2 done in under 5 s');
  });

  test('never folds a node that has something to read or did not finish cleanly', () => {
    const entry: BlindEntry = { kind: 'message', key: 'm:1', at: 0, message: message('1', T) };
    const sections = [
      section('a'),
      section('failed', { status: 'failed' }),
      section('b'),
      section('running', { status: 'running', durationMs: null }),
      section('c'),
      section('said', {}, { turns: [{ key: 't', text: { text: 'A', timestamp: T }, items: [] }] }),
      section('d'),
      section('answered', {}, { trailing: [entry] }),
      section('e'),
      section('untimed', { durationMs: null }),
    ];
    expect(shape(sections)).toEqual(sections.map(s => s.stepName));
  });
});
