import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunStream } from './RunStream';
import type { ProviderEventRecord, RunProviderEvents } from '../lib/provider-events';
import { mergeProviderEventRecords } from '../lib/provider-events';
import { buildRunLog, pairProviderToolCalls } from '../lib/run-log';
import { pathTokens, type PathToken } from '../lib/run-paths';
import type { Message } from '../primitives/message';
import { foldNodeRuns, toRunEvent } from '../primitives/event';
import type { NodeTransitionEvent, RunEvent, RunNodeState } from '../primitives/event';
import { StreamContextProvider } from '../lib/stream-context';

interface StreamFixture {
  runStartedAt?: string;
  messages: Message[];
  events: RunEvent[];
  nodes: RunNodeState[];
  providerEvents: RunProviderEvents;
  showToolCalls: boolean;
  showSystem: boolean;
  selectedNodeId: string | null;
  live: boolean;
  waitingNodeId: string | null;
  pathTokens?: readonly PathToken[];
  fullPaths?: boolean;
}

/** The stream as the run page renders it: the log built from the run's three sources. */
function renderStream({
  runStartedAt = '2026-10-02T09:59:00.000Z',
  messages,
  events,
  nodes,
  providerEvents,
  pathTokens: tokens = [],
  fullPaths = false,
  ...display
}: StreamFixture): string {
  const log = buildRunLog({
    messages,
    events,
    nodeRuns: foldNodeRuns(events, nodes),
    providerEvents,
  });
  return renderToStaticMarkup(
    <StreamContextProvider value={{ runStartedAt }}>
      <RunStream log={log} pathTokens={tokens} fullPaths={fullPaths} {...display} />
    </StreamContextProvider>
  );
}

/** What a browser would put on screen for `html`: tags gone, entities decoded. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&');

function record(
  stepName: string,
  attemptId: string | null,
  seq: number,
  observedAt: string,
  event: ProviderEventRecord['event']
): ProviderEventRecord {
  return { runId: 'r1', stepName, attemptId, seq, observedAt, event };
}

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
    costPartial: false,
    costScope: null,
    stopReason: null,
    numTurns: null,
    tokens: null,
    output: null,
    error: null,
    failureKind: null,
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
    selectedNodeId: string | null = null,
    showToolCalls = true
  ): string =>
    renderStream({
      messages: [message],
      events: [nodeStarted],
      nodes: [{ node_id: 'implement', state: 'running' }],
      providerEvents,
      showToolCalls,
      showSystem: false,
      selectedNodeId,
      live: true,
      waitingNodeId: null,
    });

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
      renderStream({
        messages: [],
        events,
        nodes: [{ node_id: 'implement', state }],
        providerEvents: lostUpdate,
        showToolCalls: true,
        showSystem: false,
        selectedNodeId: null,
        live: true,
        waitingNodeId: null,
      });

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
    const html = renderStream({
      messages: [],
      events: [nodeStarted, completed],
      nodes: [{ node_id: 'implement', state: 'completed' }],
      providerEvents: new Map(),
      showToolCalls: false,
      showSystem: false,
      selectedNodeId: null,
      live: true,
      waitingNodeId: null,
    });
    expect(html).toContain('· 00:11');
    expect(html).toContain('· $0.04');
    expect(html).toContain('· 3t');
    expect(html).toContain('tokens 12K in / 300 out');
  });

  test('falls back to message-inline tools for a run that recorded no tool events', () => {
    expect(render(new Map())).toContain('InlineOnly');
  });
});

describe('RunStream run log', () => {
  const at = '2026-10-02T10:00:00.000Z';
  const transition = (
    nodeId: string,
    kind: NodeTransitionEvent['transition'],
    second: number,
    durationMs: number | null = null
  ): NodeTransitionEvent => ({
    id: `${nodeId}:${kind}`,
    runId: 'r1',
    kind: 'node_transition',
    timestamp: `2026-10-02T10:00:${second.toString().padStart(2, '0')}.000Z`,
    nodeId,
    nodeName: nodeId,
    transition: kind,
    durationMs,
    skipReason: null,
    skipExpr: null,
    costUsd: null,
    costPartial: false,
    costScope: null,
    stopReason: null,
    numTurns: null,
    tokens: null,
    output: null,
    error: null,
    failureKind: null,
  });
  const base = {
    messages: [],
    events: [transition('route', 'started', 0)],
    nodes: [{ node_id: 'route', state: 'running' as const }],
    providerEvents: new Map(),
    showToolCalls: true,
    showSystem: false,
    selectedNodeId: null,
    live: true,
    waitingNodeId: null,
  } satisfies StreamFixture;
  const say = (seq: number, text: string): ProviderEventRecord =>
    record('route', 'a1', seq, at, { type: 'agent_message_chunk', text });
  const call = (seq: number, name: string): ProviderEventRecord =>
    record('route', 'a1', seq, at, { type: 'tool_call', toolCallId: `c${seq.toString()}`, name });

  test('groups each tool call under the text recorded before it; only a provable conversation copy sits behind System', () => {
    const fixture = {
      ...base,
      // Flushed before any of the records below by the conversation's own clock.
      messages: [
        {
          id: 'm1',
          role: 'assistant' as const,
          content: 'Text Alpha',
          timestamp: '2026-10-02T10:00:00.500Z',
          toolCalls: [],
          error: null,
          category: null,
          dispatch: null,
          workflowResult: null,
        },
        {
          id: 'm2',
          role: 'assistant' as const,
          content: 'Kept worktree: 1 commit on no remote',
          timestamp: '2026-10-02T10:00:00.600Z',
          toolCalls: [],
          error: null,
          category: null,
          dispatch: null,
          workflowResult: null,
        },
      ],
      providerEvents: new Map([
        [
          'route',
          [
            say(0, 'Text Alpha'),
            call(1, 'ToolOne'),
            call(2, 'ToolTwo'),
            say(3, 'Text Beta'),
            call(4, 'ToolThree'),
          ],
        ],
      ]),
    };
    const html = renderStream(fixture);
    const positions = ['Text Alpha', 'ToolOne', 'ToolTwo', 'Text Beta', 'ToolThree'].map(text =>
      html.indexOf(text)
    );
    expect(positions.every(position => position > -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The recorded text shows once; a notice the record does not hold shows by default.
    expect(html.split('Text Alpha').length).toBe(2);
    expect(html).not.toContain('Conversation copy');
    expect(html).toContain('Kept worktree: 1 commit on no remote');
    const withSystem = renderStream({ ...fixture, showSystem: true });
    expect(withSystem).toContain('Conversation copy');
    expect(withSystem.split('Text Alpha').length).toBe(3);
  });

  test.each([
    ['tool calls come from provider events', new Map([['route', [call(0, 'Recorded')]]])],
    ['tool calls come from the message itself', new Map()],
  ])('renders no agent card for a message with no text when %s', (_name, providerEvents) => {
    const html = renderStream({
      ...base,
      providerEvents,
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '  ',
          timestamp: '2026-10-02T10:00:01.000Z',
          toolCalls: [{ name: 'InlineOnly', input: {} }],
          error: null,
          category: null,
          dispatch: null,
          workflowResult: null,
        },
      ],
    });
    expect(html).not.toContain('>Agent<');
    expect(html).toContain(providerEvents.size > 0 ? 'Recorded' : 'InlineOnly');
  });

  describe('known paths', () => {
    const WORKTREE = 'C:\\Users\\me\\.archon\\workspaces\\acme\\app\\worktrees\\feat\\x';
    const RUN = 'C:\\Users\\me\\.archon\\workspaces\\acme\\app\\artifacts\\runs\\0a81ff6c';
    const SOURCE = 'C:\\Users\\me\\.archon\\workspaces\\acme\\app\\workflow-source\\runs\\0a81ff6c';
    const tokens = pathTokens([
      { kind: 'checkout', path: WORKTREE },
      { kind: 'run_artifacts', path: RUN },
      { kind: 'workflow_source', path: SOURCE },
    ]);
    const first = `cd "${WORKTREE}" && cat "${RUN}\\plan.md"`;
    const second = `cd "${WORKTREE}" && git status`;
    const shell = (seq: number, command: string): ProviderEventRecord =>
      record('route', 'a1', seq, at, {
        type: 'tool_call',
        toolCallId: `c${seq.toString()}`,
        name: 'Bash',
        title: command,
        rawInput: { command, description: `Step ${seq.toString()}` },
      });
    const fixture = {
      ...base,
      pathTokens: tokens,
      providerEvents: new Map([['route', [say(0, 'Reading'), shell(1, first), shell(2, second)]]]),
    };

    test('says once per node where commands run, and keys the tokens the page uses', () => {
      const html = renderStream(fixture);
      const text = textOf(html);
      expect(text.split('Commands run in ‹worktree› unless they say otherwise').length).toBe(2);
      expect(text).toContain('cat "‹run›\\plan.md"');
      expect(text).not.toContain('cd "');
      // The key: token, what it is, full path. A token no row shows is left out.
      expect(text).toContain(`‹worktree›the run's checkout${WORKTREE}`);
      expect(text).toContain(`‹run›this run's artifacts${RUN}`);
      expect(text).not.toContain('‹source›');
      expect(text).not.toContain(SOURCE);
    });

    test('Full paths shows every command exactly as recorded, with no key and no node line', () => {
      const text = textOf(renderStream({ ...fixture, fullPaths: true }));
      expect(text).toContain(first);
      expect(text).toContain(second);
      expect(text).not.toContain('‹');
      expect(text).not.toContain('Commands run in');
    });

    test('hiding tool calls hides the lines that describe them', () => {
      const text = textOf(renderStream({ ...fixture, showToolCalls: false }));
      expect(text).toContain('Reading');
      expect(text).not.toContain('‹');
    });
  });

  describe('quiet nodes', () => {
    const done = ['start', 'interpret', 'pick'];
    const skipped = ['blocked', 'revisit', 'retriage', 'facts'];
    const quiet = [...done, ...skipped];
    const events = [
      ...quiet.flatMap((id, index) =>
        done.includes(id)
          ? [transition(id, 'started', index), transition(id, 'completed', index, 1200)]
          : [transition(id, 'skipped', index)]
      ),
      transition('route', 'started', 30),
    ];
    const fixture = {
      ...base,
      events,
      nodes: [
        ...quiet.map(id => ({
          node_id: id,
          state: done.includes(id) ? ('completed' as const) : ('skipped' as const),
        })),
        { node_id: 'route', state: 'running' as const },
      ],
    };

    test('fold into one line that expands to the list', () => {
      const html = renderStream(fixture);
      const details = /<details[^>]*>(.*?)<\/details>/s.exec(html)?.[1] ?? '';
      expect(details).toContain('7 steps · 3 done in under 5 s · 4 skipped</summary>');
      for (const id of quiet) expect(details).toContain(`id="node-transition-${id}"`);
      expect(details).not.toContain('node-transition-route');
      expect(html).toContain('id="node-transition-route"');
      expect(html.split('<details').length).toBe(2);
    });

    test('a selected node is shown by itself, outside any fold', () => {
      const html = renderStream({ ...fixture, selectedNodeId: 'pick' });
      expect(html).toContain('id="node-transition-pick"');
      expect(html).not.toContain('<details');
      expect(html).not.toContain('node-transition-start');
    });
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
  const html = renderStream({
    runStartedAt: event.timestamp,
    messages: [],
    events: [event],
    nodes: [],
    providerEvents: new Map(),
    showToolCalls: false,
    showSystem: true,
    selectedNodeId: null,
    live: true,
    waitingNodeId: null,
  });
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
    const html = renderStream({
      runStartedAt: event.timestamp,
      messages: [],
      events: [event],
      nodes: [],
      providerEvents: new Map(),
      showToolCalls: false,
      showSystem,
      selectedNodeId: null,
      live: true,
      waitingNodeId: null,
    });
    for (const warning of warnings) expect(html).toContain(warning);
    expect(html).not.toContain('Waiting for first event');
  });
});

test.each(
  (['own', 'total'] as const).flatMap(scope =>
    [
      { cost: 0.03, formatted: '0.03' },
      { cost: 0.036, formatted: '0.03' },
      { cost: 0.00006, formatted: '0.0000' },
    ].map(({ cost, formatted }) => ({ scope, cost, formatted }))
  )
)('RunStream labels persisted partial cost as a floor (%j)', ({ scope, cost, formatted }) => {
  const event = toRunEvent({
    id: 'cost',
    workflow_run_id: 'r1',
    event_type: 'node_completed',
    step_index: null,
    step_name: 'grp',
    cost_scope: scope,
    data: { cost_usd: cost, cost_partial: true },
    created_at: '2026-10-02T10:00:00.000Z',
  });
  const html = renderStream({
    runStartedAt: event.timestamp,
    messages: [],
    events: [event],
    nodes: [{ node_id: 'grp', state: 'completed' }],
    providerEvents: new Map(),
    showToolCalls: false,
    showSystem: false,
    selectedNodeId: null,
    live: true,
    waitingNodeId: null,
  });
  expect(html).toContain(`· ${scope === 'total' ? 'total ' : ''}at least $${formatted}`);
});
