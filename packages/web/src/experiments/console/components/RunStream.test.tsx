import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunStream, pairProviderToolCalls } from './RunStream';
import type { ProviderEventRecord, RunProviderEvents } from '../lib/provider-events';
import { mergeProviderEventRecords } from '../lib/provider-events';
import type { Message } from '../primitives/message';
import { toRunEvent } from '../primitives/event';
import type { NodeTransitionEvent } from '../primitives/event';
import { StreamContextProvider } from '../lib/stream-context';

function record(
  stepName: string,
  attemptId: string | null,
  seq: number,
  observedAt: string,
  event: ProviderEventRecord['event']
): ProviderEventRecord {
  return { runId: 'r1', stepName, attemptId, seq, observedAt, event };
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

describe('RunStream tool rendering', () => {
  const nodeStarted: NodeTransitionEvent = {
    id: 'n1',
    runId: 'r1',
    kind: 'node_transition',
    timestamp: '2026-10-02T09:59:59.000Z',
    nodeId: 'implement',
    nodeName: 'implement',
    transition: 'started',
    durationMs: null,
    skipReason: null,
    skipExpr: null,
    costUsd: null,
    costScope: null,
    stopReason: null,
    numTurns: null,
    tokens: null,
  };
  const message: Message = {
    id: 'm1',
    role: 'assistant',
    content: 'working',
    timestamp: '2026-10-02T10:00:00.000Z',
    toolCalls: [{ name: 'InlineOnly', input: {} }],
    error: null,
    category: null,
    dispatch: null,
    workflowResult: null,
  };

  const render = (
    providerEvents: RunProviderEvents,
    selectedNodeId = 'all',
    showToolCalls = true
  ): string =>
    renderToStaticMarkup(
      <StreamContextProvider value={{ runStartedAt: '2026-10-02T09:59:00.000Z' }}>
        <RunStream
          messages={[message]}
          events={[nodeStarted]}
          nodes={[{ node_id: 'implement', state: 'running' }]}
          providerEvents={providerEvents}
          showToolCalls={showToolCalls}
          showSystem={false}
          selectedNodeId={selectedNodeId}
        />
      </StreamContextProvider>
    );

  test('renders recorded hook lifecycle events in order beside tool calls', () => {
    const records: ProviderEventRecord[] = [
      record('implement', 'a1', 0, '2026-10-02T10:00:00.100Z', {
        type: 'hook',
        hookId: 'h1',
        hookName: 'check-policy',
        hookEvent: 'PreToolUse',
        status: 'started',
      }),
      record('implement', 'a1', 1, '2026-10-02T10:00:00.200Z', {
        type: 'hook',
        hookId: 'h1',
        hookName: 'check-policy',
        hookEvent: 'PreToolUse',
        status: 'succeeded',
        exitCode: 0,
      }),
      record('implement', 'a1', 2, '2026-10-02T10:00:00.300Z', {
        type: 'tool_call',
        toolCallId: 't1',
        name: 'Bash',
        rawInput: { command: 'git commit' },
      }),
      record('implement', 'a1', 3, '2026-10-02T10:00:00.400Z', {
        type: 'hook',
        hookId: 'h2',
        hookName: 'lint-check',
        hookEvent: 'PostToolUse',
        status: 'failed',
        exitCode: 2,
      }),
      record('implement', 'a1', 4, '2026-10-02T10:00:00.500Z', {
        type: 'hook',
        hookId: 'h3',
        hookName: 'cleanup',
        hookEvent: 'Stop',
        status: 'cancelled',
      }),
      record('implement', 'a1', 5, '2026-10-02T10:00:00.600Z', {
        type: 'tool_call_update',
        toolCallId: 't1',
        status: 'failed',
        exitCode: 1,
      }),
    ];
    const events: RunProviderEvents = new Map([
      ['implement', mergeProviderEventRecords([], records, 'load')],
      [
        'review',
        [
          record('review', 'a2', 0, '2026-10-02T10:00:00.700Z', {
            type: 'hook',
            hookId: 'h1',
            hookName: 'review-hook',
            hookEvent: 'PreToolUse',
            status: 'started',
          }),
        ],
      ],
    ]);
    const html = render(events, 'implement');
    for (const text of [
      'Hook',
      'check-policy',
      'PreToolUse',
      'started',
      'succeeded',
      'exit 0',
      'lint-check',
      'PostToolUse',
      'failed',
      'exit 2',
      'cleanup',
      'Stop',
      'cancelled',
      'Bash',
      'git commit',
      'exit 1',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('failed (exit 2)');
    expect(html).toContain('dateTime="2026-10-02T10:00:00.400Z"');
    expect(html.indexOf('started')).toBeLessThan(html.indexOf('succeeded'));
    expect(html.indexOf('succeeded')).toBeLessThan(html.indexOf('Bash'));
    expect(html.indexOf('Bash')).toBeLessThan(html.indexOf('lint-check'));
    expect(html.indexOf('lint-check')).toBeLessThan(html.indexOf('cleanup'));
    expect(html).not.toContain('review-hook');
    expect(html).not.toContain('InlineOnly');
    expect(render(events, 'review')).toContain('review-hook');
    expect(render(events, 'review')).not.toContain('lint-check');
    expect(render(events, 'implement', false)).toContain('lint-check');
    expect(render(events, 'implement', false)).not.toContain('Bash');
  });

  test.each([
    ['native', ['a1']],
    ['legacy', [null]],
    ['native retries', ['a1', 'a2']],
    ['legacy then native', [null, 'a2']],
  ] as const)('preserves equal-time hook/tool order for %s', (_name, attempts) => {
    const timestamp = '2026-10-02T10:00:00.100Z';
    const records: ProviderEventRecord[] = [];
    const expectedOrder: string[] = [];
    for (const [attemptIndex, attemptId] of attempts.entries()) {
      for (const [index, status] of (
        ['started', 'succeeded', 'failed', 'cancelled'] as const
      ).entries()) {
        const hookName = `hook-${attemptIndex}-${status}`;
        const toolName = `tool-${attemptIndex}-${status}`;
        records.push(
          record('implement', attemptId, index * 3, timestamp, {
            type: 'hook',
            hookId: hookName,
            hookName,
            hookEvent: 'PreToolUse',
            status,
          }),
          record('implement', attemptId, index * 3 + 1, timestamp, {
            type: 'tool_call',
            toolCallId: `t${index}`,
            name: toolName,
          }),
          record('implement', attemptId, index * 3 + 2, timestamp, {
            type: 'tool_call_update',
            toolCallId: `t${index}`,
            status: 'completed',
          })
        );
        expectedOrder.push(hookName, toolName);
      }
    }
    const html = render(new Map([['implement', mergeProviderEventRecords([], records, 'load')]]));
    const positions = expectedOrder.map(name => html.indexOf(name));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test('hook records do not suppress message-inline tool calls', () => {
    const html = render(
      new Map([
        [
          'implement',
          [
            record('implement', 'a1', 0, '2026-10-02T10:00:00.100Z', {
              type: 'hook',
              hookId: 'h1',
              hookName: 'native-hook',
              hookEvent: 'PreToolUse',
              status: 'failed',
            }),
          ],
        ],
      ])
    );
    expect(html).toContain('native-hook');
    expect(html).toContain('InlineOnly');
  });

  test.each(['patch text', 0, false, null, ['a', 1]].map(input => [input] as const))(
    'renders and preserves non-object tool input %j',
    input => {
      const events: RunProviderEvents = new Map([
        [
          'implement',
          [
            record('implement', 'a1', 0, '2026-10-02T10:00:00.500Z', {
              type: 'tool_call',
              toolCallId: 'patch',
              name: 'apply_patch',
              rawInput: input,
            }),
          ],
        ],
      ]);
      expect(pairProviderToolCalls(events)[0]?.call.input).toEqual(input);
      const html = render(events);
      expect(html).toContain('apply_patch');
      expect(html).toContain('▸');
      if (
        typeof input === 'string' ||
        typeof input === 'number' ||
        typeof input === 'boolean' ||
        input === null
      ) {
        expect(html).toContain(String(input));
      } else expect(html).toContain('[&quot;a&quot;,1]');
    }
  );

  test('shows provider-event tools under their node, and not the message-inline copy', () => {
    const html = render(
      new Map([
        [
          'implement',
          [
            record('implement', 'a1', 0, '2026-10-02T10:00:00.500Z', {
              type: 'tool_call',
              toolCallId: 'x',
              name: 'Grep',
            }),
          ],
        ],
      ]),
      'implement'
    );
    expect(html).toContain('Grep');
    expect(html).not.toContain('InlineOnly');
  });

  test('a call with no recorded outcome reads as such once its node finished, not as running', () => {
    const lostUpdate: RunProviderEvents = new Map([
      [
        'implement',
        [
          record('implement', 'a1', 0, '2026-10-02T10:00:00.500Z', {
            type: 'tool_call',
            toolCallId: 'x',
            name: 'Grep',
          }),
        ],
      ],
    ]);
    const finished: NodeTransitionEvent = { ...nodeStarted, id: 'n2', transition: 'completed' };
    const html = (events: NodeTransitionEvent[], state: 'running' | 'completed'): string =>
      renderToStaticMarkup(
        <StreamContextProvider value={{ runStartedAt: '2026-10-02T09:59:00.000Z' }}>
          <RunStream
            messages={[]}
            events={events}
            nodes={[{ node_id: 'implement', state }]}
            providerEvents={lostUpdate}
            showToolCalls
            showSystem={false}
            selectedNodeId="all"
          />
        </StreamContextProvider>
      );

    expect(html([nodeStarted], 'running')).not.toContain('no result recorded');
    expect(html([nodeStarted, finished], 'completed')).toContain('no result recorded');
  });

  test('shows completion tokens beside duration, cost, and turns in the node divider', () => {
    const completed: NodeTransitionEvent = {
      ...nodeStarted,
      id: 'n2',
      transition: 'completed',
      durationMs: 11370,
      costUsd: 0.04,
      numTurns: 3,
      tokens: { input: 12000, output: 300 },
    };
    const html = renderToStaticMarkup(
      <StreamContextProvider value={{ runStartedAt: '2026-10-02T09:59:00.000Z' }}>
        <RunStream
          messages={[]}
          events={[nodeStarted, completed]}
          nodes={[{ node_id: 'implement', state: 'completed' }]}
          providerEvents={new Map()}
          showToolCalls={false}
          showSystem={false}
          selectedNodeId="all"
        />
      </StreamContextProvider>
    );
    expect(html).toContain('· 00:11');
    expect(html).toContain('· $0.04');
    expect(html).toContain('· 3t');
    expect(html).toContain('tokens 12K in / 300 out');
  });

  test('falls back to message-inline tools for a run that recorded no tool events', () => {
    expect(render(new Map())).toContain('InlineOnly');
  });
});

test('RunStream renders the diagnostic message of an error event', () => {
  const diagnostic = 'Provider rejected the run because the token expired';
  const event = toRunEvent({
    id: 'error',
    workflow_run_id: 'r1',
    event_type: 'error',
    step_index: null,
    step_name: null,
    data: { error: diagnostic },
    created_at: '2026-10-02T10:00:00.000Z',
  });
  const html = renderToStaticMarkup(
    <StreamContextProvider value={{ runStartedAt: event.timestamp }}>
      <RunStream
        messages={[]}
        events={[event]}
        nodes={[]}
        providerEvents={new Map()}
        showToolCalls={false}
        showSystem
        selectedNodeId="all"
      />
    </StreamContextProvider>
  );
  expect(html).toContain(diagnostic);
});

describe('RunStream cleanup warnings', () => {
  test.each([false, true])('renders full normalized warning with showSystem=%s', showSystem => {
    const warnings = [
      'Some process outside the run process group still holds output; it was not signalled.',
      `Retain the checkout. ${'Inspection detail. '.repeat(30)}Use lsof on the checkout before retrying abandonment.`,
    ];
    const event = toRunEvent({
      id: 'warning',
      workflow_run_id: 'r1',
      event_type: 'workflow_cleanup_warning',
      step_index: null,
      step_name: null,
      data: { warnings },
      created_at: '2026-10-02T10:00:00.000Z',
    });
    const html = renderToStaticMarkup(
      <StreamContextProvider value={{ runStartedAt: event.timestamp }}>
        <RunStream
          messages={[]}
          events={[event]}
          nodes={[]}
          providerEvents={new Map()}
          showToolCalls={false}
          showSystem={showSystem}
          selectedNodeId="all"
        />
      </StreamContextProvider>
    );
    for (const warning of warnings) expect(html).toContain(warning);
    expect(html).not.toContain('Waiting for first event');
  });
});
