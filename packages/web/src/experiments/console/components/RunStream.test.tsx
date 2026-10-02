import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunStream, pairProviderToolCalls } from './RunStream';
import type { ProviderEventRecord, RunProviderEvents } from '../lib/provider-events';
import type { Message } from '../primitives/message';
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
  const nodeStarted = {
    id: 'n1',
    runId: 'r1',
    kind: 'node_transition' as const,
    timestamp: '2026-10-02T09:59:59.000Z',
    nodeId: 'implement',
    nodeName: 'implement',
    transition: 'started' as const,
    durationMs: null,
    skipReason: null,
    skipExpr: null,
    outputPreview: null,
    costUsd: null,
    stopReason: null,
    numTurns: null,
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

  const render = (providerEvents: RunProviderEvents, selectedNodeId = 'all'): string =>
    renderToStaticMarkup(
      <StreamContextProvider value={{ runStartedAt: '2026-10-02T09:59:00.000Z' }}>
        <RunStream
          messages={[message]}
          events={[nodeStarted]}
          providerEvents={providerEvents}
          showToolCalls
          showSystem={false}
          selectedNodeId={selectedNodeId}
        />
      </StreamContextProvider>
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

  test('falls back to message-inline tools for a run that recorded no tool events', () => {
    expect(render(new Map())).toContain('InlineOnly');
  });
});
