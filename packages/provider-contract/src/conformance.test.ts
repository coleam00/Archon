import { describe, expect, test } from 'bun:test';
import {
  checkCredentialStatuses,
  checkBackgroundSettle,
  checkEventVocabulary,
  checkFailureClasses,
  checkSessionIdReported,
  checkSettled,
  runProviderConformance,
  type CredentialStatusCase,
  type ProviderFailureCase,
  type ProviderForkCase,
  type ProviderTurnCase,
} from './conformance';
import { credentialStatusSchema } from './credential-status';

function turn(...chunks: unknown[]): () => AsyncIterable<unknown> {
  return async function* () {
    yield* chunks;
  };
}

const resumable = { sessionResume: true, backgroundWork: 'unobserved' as const };

const failedTurnEnd = [
  { type: 'result', isError: true, failure: { class: 'auth', evidence: 'HTTP 401' } },
  { type: 'settled' },
];

const conforming: ProviderFailureCase = {
  name: 'expired key',
  expected: 'auth',
  evidence: 'HTTP 401',
  run: turn({ type: 'agent_message_chunk', text: 'partial' }, ...failedTurnEnd),
};

const settlingTurn: ProviderTurnCase = {
  name: 'background work',
  run: turn(
    { type: 'result', sessionId: 'session-1' },
    { type: 'state_update', state: 'running' },
    { type: 'result', sessionId: 'session-1' },
    { type: 'settled' }
  ),
};

describe('failure-class conformance', () => {
  test('a provider that reports the expected class conforms', async () => {
    expect(
      await runProviderConformance({
        capabilities: resumable,
        failureCases: [conforming],
        turns: [settlingTurn],
      })
    ).toEqual([]);
  });

  test.each<[string, ProviderFailureCase, string]>([
    [
      'wrong class',
      {
        ...conforming,
        run: turn({
          type: 'result',
          isError: true,
          failure: { class: 'transient', evidence: 'HTTP 401' },
        }),
      },
      'expired key: reported transient, expected auth',
    ],
    [
      'evidence that drops the vendor text',
      {
        ...conforming,
        run: turn({
          type: 'result',
          isError: true,
          failure: { class: 'auth', evidence: 'authentication failed' },
        }),
      },
      'expired key: evidence does not keep the vendor text "HTTP 401"',
    ],
    [
      'a failed result without isError',
      {
        ...conforming,
        run: turn({ type: 'result', failure: { class: 'auth', evidence: 'HTTP 401' } }),
      },
      'expired key: a failed result does not set isError',
    ],
    [
      'no failure on the result',
      { ...conforming, run: turn({ type: 'result', isError: true, errors: ['401'] }) },
      'expired key: result carries no failure',
    ],
    [
      'malformed failure',
      { ...conforming, run: turn({ type: 'result', failure: { class: 'auth', evidence: '' } }) },
      'expired key: failure is malformed',
    ],
    [
      'no result',
      { ...conforming, run: turn({ type: 'assistant', content: 'x' }) },
      'expired key: expected one result, got 0',
    ],
    [
      'two results',
      {
        ...conforming,
        run: turn(
          { type: 'result', failure: { class: 'auth', evidence: 'a' } },
          { type: 'result', failure: { class: 'auth', evidence: 'b' } }
        ),
      },
      'expired key: expected one result, got 2',
    ],
    [
      'throws instead of reporting',
      {
        ...conforming,
        run: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('Claude Code auth error: 401')),
          }),
        }),
      },
      'expired key: threw instead of reporting a typed failure',
    ],
  ])('flags %s', async (_label, failureCase, violation) => {
    const violations = await checkFailureClasses([failureCase]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toStartWith(violation);
  });
});

describe('settled conformance', () => {
  test.each<[string, ProviderTurnCase, string]>([
    [
      'no settled',
      { ...settlingTurn, run: turn({ type: 'result', sessionId: 'session-1' }) },
      'background work: expected one settled, got 0',
    ],
    [
      'two settled',
      {
        ...settlingTurn,
        run: turn(
          { type: 'result', sessionId: 'session-1' },
          { type: 'settled' },
          { type: 'settled' }
        ),
      },
      'background work: expected one settled, got 2',
    ],
    [
      'settled before the final result',
      {
        ...settlingTurn,
        run: turn(
          { type: 'result', sessionId: 'session-1' },
          { type: 'settled' },
          { type: 'result', sessionId: 'session-1' }
        ),
      },
      'background work: settled is not the last chunk',
    ],
    [
      'settled with no result',
      { ...settlingTurn, run: turn({ type: 'settled' }) },
      'background work: settled arrives before any result',
    ],
  ])('flags %s', async (_label, turnCase, violation) => {
    const violations = await checkSettled([turnCase]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toStartWith(violation);
  });

  test('a failed turn must settle too', async () => {
    const unsettledFailure: ProviderFailureCase = {
      ...conforming,
      run: turn({
        type: 'result',
        isError: true,
        failure: { class: 'auth', evidence: 'HTTP 401' },
      }),
    };
    expect(
      await runProviderConformance({
        capabilities: resumable,
        failureCases: [unsettledFailure],
        turns: [settlingTurn],
      })
    ).toEqual(['expired key: expected one settled, got 0']);
  });
});

const toolTurnChunks: Record<string, unknown>[] = [
  { type: 'tool_call', toolCallId: 'a', name: 'Read' },
  { type: 'tool_call', toolCallId: 'b', name: 'Bash', title: 'sleep 60' },
  { type: 'subtask', taskId: 't', status: 'started' },
  { type: 'tool_call_update', toolCallId: 'a', status: 'completed', output: 'file' },
  { type: 'subtask', taskId: 't', status: 'completed' },
  { type: 'tool_call_update', toolCallId: 'b', status: 'cancelled' },
  { type: 'result', sessionId: 'session-1', stopReason: 'cancelled' },
  { type: 'settled' },
];

const toolTurn: ProviderTurnCase = { name: 'tool turn', run: turn(...toolTurnChunks) };

describe('event vocabulary conformance', () => {
  test('a conforming tool turn passes every check', async () => {
    expect(
      await runProviderConformance({
        capabilities: resumable,
        failureCases: [conforming],
        turns: [settlingTurn],
        toolTurn,
      })
    ).toEqual([]);
  });

  test.each<[string, unknown[], string]>([
    [
      'an unparseable chunk',
      [
        { type: 'assistant', content: 'hi' },
        { type: 'result', sessionId: 'session-1' },
        { type: 'settled' },
      ],
      'tool turn: rule 1, chunk 0 (type "assistant") is not a provider chunk',
    ],
    [
      'an unclosed tool call',
      [
        { type: 'tool_call', toolCallId: 'a', name: 'Read' },
        { type: 'result', sessionId: 'session-1' },
        { type: 'settled' },
      ],
      'tool turn: rule 2, tool call a is still open at a result',
    ],
    [
      'a tool call left open at the end of the stream',
      [{ type: 'tool_call', toolCallId: 'a', name: 'Read' }],
      'tool turn: rule 2, tool call a is never closed',
    ],
    [
      'a tool call closed only after the result',
      [
        { type: 'tool_call', toolCallId: 'a', name: 'Read' },
        { type: 'result', sessionId: 'session-1' },
        { type: 'tool_call_update', toolCallId: 'a', status: 'completed' },
        { type: 'settled' },
      ],
      'tool turn: rule 2, tool call a is still open at a result',
    ],
    [
      'a call started after the first result and left open at the next',
      [
        { type: 'result', sessionId: 'session-1' },
        { type: 'tool_call', toolCallId: 'a', name: 'Read' },
        { type: 'result', sessionId: 'session-1' },
        { type: 'settled' },
      ],
      'tool turn: rule 2, tool call a is still open at a result',
    ],
    [
      'a tool call closed twice',
      [
        { type: 'tool_call', toolCallId: 'a', name: 'Read' },
        { type: 'tool_call_update', toolCallId: 'a', status: 'completed' },
        { type: 'tool_call_update', toolCallId: 'a', status: 'failed' },
        { type: 'result', sessionId: 'session-1' },
        { type: 'settled' },
      ],
      'tool turn: rule 2, tool call a is closed twice',
    ],
    [
      'a duplicate tool call id',
      [
        { type: 'tool_call', toolCallId: 'a', name: 'Read' },
        { type: 'tool_call_update', toolCallId: 'a', status: 'completed' },
        { type: 'tool_call', toolCallId: 'a', name: 'Read' },
        { type: 'result', sessionId: 'session-1' },
        { type: 'settled' },
      ],
      'tool turn: rule 2, tool call a is started twice',
    ],
    [
      'an update without a start',
      [
        { type: 'tool_call_update', toolCallId: 'z', status: 'completed' },
        { type: 'result', sessionId: 'session-1' },
        { type: 'settled' },
      ],
      'tool turn: rule 3, tool call z is updated before it starts',
    ],
    [
      'a subtask left open at settled',
      [
        { type: 'subtask', taskId: 't', status: 'started' },
        { type: 'subtask', taskId: 't', status: 'running' },
        { type: 'result', sessionId: 'session-1' },
        { type: 'settled' },
      ],
      'tool turn: rule 4, subtask t is still open at settled',
    ],
    [
      'a subtask seen only as running',
      [
        { type: 'subtask', taskId: 't', status: 'running' },
        { type: 'result', sessionId: 'session-1' },
        { type: 'settled' },
      ],
      'tool turn: rule 4, subtask t is still open at settled',
    ],
    [
      'a subtask that runs again after it completed',
      [
        { type: 'subtask', taskId: 't', status: 'started' },
        { type: 'subtask', taskId: 't', status: 'completed' },
        { type: 'subtask', taskId: 't', status: 'running' },
        { type: 'result', sessionId: 'session-1' },
        { type: 'settled' },
      ],
      'tool turn: rule 4, subtask t is still open at settled',
    ],
  ])('flags %s', async (_label, chunks, violation) => {
    expect(await checkEventVocabulary([{ name: 'tool turn', run: turn(...chunks) }])).toEqual([
      expect.stringContaining(violation),
    ]);
  });

  test.each(['failed', 'stopped'])('a subtask closes with %s', async status => {
    const closed = turn(
      { type: 'subtask', taskId: 't', status: 'started' },
      { type: 'subtask', taskId: 't', status },
      { type: 'result', sessionId: 'session-1' },
      { type: 'settled' }
    );
    expect(await checkEventVocabulary([{ name: 'tool turn', run: closed }])).toEqual([]);
  });

  test('a call started after the first result may close before the next one', async () => {
    const backgroundCall = turn(
      { type: 'result', sessionId: 'session-1' },
      { type: 'tool_call', toolCallId: 'a', name: 'Read' },
      { type: 'tool_call_update', toolCallId: 'a', status: 'completed' },
      { type: 'result', sessionId: 'session-1' },
      { type: 'settled' }
    );
    expect(await checkEventVocabulary([{ name: 'tool turn', run: backgroundCall }])).toEqual([]);
  });

  test.each<[string, unknown[], string]>([
    [
      'an unclosed call',
      [
        { type: 'tool_call', toolCallId: 'a', name: 'Read' },
        { type: 'tool_call', toolCallId: 'b', name: 'Bash' },
        { type: 'tool_call_update', toolCallId: 'b', status: 'cancelled' },
        { type: 'result', sessionId: 'session-1' },
        { type: 'settled' },
      ],
      'tool turn: rule 2, tool call a is still open at a result',
    ],
    [
      'no interrupted call',
      [
        { type: 'tool_call', toolCallId: 'a', name: 'Read' },
        { type: 'tool_call_update', toolCallId: 'a', status: 'completed' },
        { type: 'tool_call', toolCallId: 'b', name: 'Read' },
        { type: 'tool_call_update', toolCallId: 'b', status: 'completed' },
        { type: 'result', sessionId: 'session-1' },
        { type: 'settled' },
      ],
      'tool turn: the tool turn needs two tool calls and one cancelled, got 2 and 0',
    ],
    [
      'only one call',
      [
        { type: 'tool_call', toolCallId: 'a', name: 'Read' },
        { type: 'tool_call_update', toolCallId: 'a', status: 'cancelled' },
        { type: 'result', sessionId: 'session-1' },
        { type: 'settled' },
      ],
      'tool turn: the tool turn needs two tool calls and one cancelled, got 1 and 1',
    ],
  ])('runProviderConformance flags a tool turn with %s', async (_label, chunks, violation) => {
    expect(
      await runProviderConformance({
        capabilities: resumable,
        failureCases: [conforming],
        turns: [settlingTurn],
        toolTurn: { name: 'tool turn', run: turn(...chunks) },
      })
    ).toEqual([violation]);
  });

  test('the tool turn must settle', async () => {
    const unsettled: ProviderTurnCase = {
      ...toolTurn,
      run: turn({ type: 'result', sessionId: 'session-1' }),
    };
    expect(
      await runProviderConformance({
        capabilities: resumable,
        failureCases: [conforming],
        turns: [],
        toolTurn: unsettled,
      })
    ).toContain('tool turn: expected one settled, got 0');
  });

  test('every fixture, not only the tool turn, must speak the vocabulary', async () => {
    const legacy = { type: 'assistant', content: 'hi' };
    const violations = await runProviderConformance({
      capabilities: resumable,
      failureCases: [{ ...conforming, run: turn(legacy, ...failedTurnEnd) }],
      turns: [
        {
          name: 'plain turn',
          run: turn(legacy, { type: 'result', sessionId: 'session-1' }, { type: 'settled' }),
        },
      ],
    });
    expect(violations).toEqual([
      expect.stringContaining('plain turn: rule 1, chunk 0 (type "assistant")'),
      expect.stringContaining('expired key: rule 1, chunk 0 (type "assistant")'),
    ]);
  });
});

describe('credential status conformance', () => {
  const secret = 'sk-planted-secret-value';
  const dead: CredentialStatusCase = {
    name: 'dead refresh token',
    expected: 'unusable',
    secret,
    check: async () => ({ state: 'unusable', source: 'archon', evidence: 'HTTP 401' }),
  };

  test('a status with the expected state and no secret conforms', async () => {
    expect(await checkCredentialStatuses([dead])).toEqual([]);
  });

  test.each<[string, CredentialStatusCase, string]>([
    [
      'the secret in evidence',
      {
        ...dead,
        check: async () => ({ state: 'unusable', source: 'archon', evidence: `bad key ${secret}` }),
      },
      'dead refresh token: status contains the credential value',
    ],
    [
      'the secret in a key the schema strips',
      {
        ...dead,
        check: async () => ({ state: 'unusable', source: 'archon', evidence: 'x', key: secret }),
      },
      'dead refresh token: status contains the credential value',
    ],
    [
      'the wrong state',
      { ...dead, check: async () => ({ state: 'usable', source: 'archon' }) },
      'dead refresh token: reported usable, expected unusable',
    ],
  ])('reports %s', async (_label, statusCase, violation) => {
    expect(await checkCredentialStatuses([statusCase])).toEqual([violation]);
  });

  test('reports a malformed status and a throw', async () => {
    const violations = await checkCredentialStatuses([
      { ...dead, check: async () => ({ state: 'unusable', source: 'archon' }) },
      {
        ...dead,
        check: async () => {
          throw new Error('boom');
        },
      },
    ]);
    expect(violations[0]).toStartWith('dead refresh token: status is malformed');
    expect(violations[1]).toBe('dead refresh token: threw instead of reporting a status (boom)');
  });
});

describe('credential status schema', () => {
  test.each(['unusable', 'check_failed'])('%s requires evidence', state => {
    expect(credentialStatusSchema.safeParse({ state, source: 'native' }).success).toBe(false);
    expect(
      credentialStatusSchema.safeParse({ state, source: 'native', evidence: 'why' }).success
    ).toBe(true);
  });

  test.each(['usable', 'not_connected', 'not_checked'])('%s needs no evidence', state => {
    expect(credentialStatusSchema.safeParse({ state, source: 'archon' }).success).toBe(true);
  });
});

describe('session id conformance', () => {
  test('a turn whose results all name their session conforms', async () => {
    expect(await checkSessionIdReported([settlingTurn])).toEqual([]);
  });

  test.each<[string, unknown]>([
    ['absent', undefined],
    ['empty', ''],
  ])('a result whose sessionId is %s is a violation', async (_label, sessionId) => {
    const unnamed: ProviderTurnCase = {
      name: 'plain turn',
      run: turn(
        { type: 'result', sessionId: 'session-1' },
        { type: 'result', sessionId },
        {
          type: 'settled',
        }
      ),
    };
    expect(
      await runProviderConformance({
        capabilities: resumable,
        failureCases: [conforming],
        turns: [unnamed],
      })
    ).toEqual(['plain turn: 1 of 2 results carry no sessionId']);
  });

  test('the tool turn must name its session too', async () => {
    const chunks = toolTurnChunks.map(chunk =>
      chunk.type === 'result' ? { ...chunk, sessionId: undefined } : chunk
    );
    expect(
      await runProviderConformance({
        capabilities: resumable,
        failureCases: [conforming],
        turns: [settlingTurn],
        toolTurn: { ...toolTurn, run: turn(...chunks) },
      })
    ).toEqual(['tool turn: 1 of 1 results carry no sessionId']);
  });

  test('a provider that cannot resume sessions is not asked to name one', async () => {
    const unnamed: ProviderTurnCase = {
      name: 'plain turn',
      run: turn({ type: 'result' }, { type: 'settled' }),
    };
    expect(
      await runProviderConformance({
        capabilities: { sessionResume: false, backgroundWork: 'unobserved' },
        failureCases: [conforming],
        turns: [unnamed],
      })
    ).toEqual([]);
  });
});

describe('runtime-backed background settlement', () => {
  test('reported providers must supply background evidence', async () => {
    expect(
      await runProviderConformance({
        capabilities: { sessionResume: false, backgroundWork: 'reported' },
        turns: [],
        failureCases: [],
      })
    ).toEqual(['reported provider has no background conformance cases']);
  });
  test.each(['early settle', 'invented stop', 'runtime completion'] as const)('%s', async mode => {
    let status: 'running' | 'completed' = 'running';
    const violations = await checkBackgroundSettle([
      {
        name: mode,
        runtimeStatus: () => status,
        run: async function* () {
          yield { type: 'subtask', taskId: 't', status: 'started' };
          yield { type: 'result' };
          if (mode === 'runtime completion') {
            status = 'completed';
            yield { type: 'subtask', taskId: 't', status: 'completed' };
          } else if (mode === 'invented stop') {
            yield { type: 'subtask', taskId: 't', status: 'stopped' };
          }
          yield { type: 'settled' };
          status = 'completed';
        },
      },
    ]);
    if (mode === 'runtime completion') expect(violations).toEqual([]);
    else expect(violations).toContain(`${mode}: runtime still reports t live at settled`);
    if (mode === 'invented stop')
      expect(violations).toContain('invented stop: invented stopped for t');
  });
});

describe('session fork conformance', () => {
  const forking = { sessionResume: true, sessionFork: true, backgroundWork: 'unobserved' as const };
  const forkTurn: ProviderForkCase = {
    name: 'fork turn',
    source: 'session-1',
    run: turn({ type: 'result', sessionId: 'fork-1', resumed: true }, { type: 'settled' }),
  };

  test('a fork that restores the source into a new session conforms', async () => {
    expect(
      await runProviderConformance({
        capabilities: forking,
        failureCases: [conforming],
        turns: [settlingTurn],
        forkTurn,
      })
    ).toEqual([]);
  });

  test.each<[string, Record<string, unknown>, string]>([
    [
      'reuses the source session',
      { sessionId: 'session-1', resumed: true },
      'fork turn: a result names the source session, not a fork',
    ],
    [
      'does not report the source restored',
      { sessionId: 'fork-1' },
      'fork turn: a result does not report the source session restored',
    ],
  ])('a fork that %s is a violation', async (_label, result, violation) => {
    expect(
      await runProviderConformance({
        capabilities: forking,
        failureCases: [conforming],
        turns: [settlingTurn],
        forkTurn: { ...forkTurn, run: turn({ type: 'result', ...result }, { type: 'settled' }) },
      })
    ).toEqual([violation]);
  });

  test('a provider that declares sessionFork must supply a fork turn', async () => {
    expect(
      await runProviderConformance({
        capabilities: forking,
        failureCases: [conforming],
        turns: [settlingTurn],
      })
    ).toEqual(['the provider declares sessionFork but the suite has no forkTurn']);
  });

  test('the fork turn must settle', async () => {
    expect(
      await runProviderConformance({
        capabilities: forking,
        failureCases: [conforming],
        turns: [],
        forkTurn: {
          ...forkTurn,
          run: turn({ type: 'result', sessionId: 'fork-1', resumed: true }),
        },
      })
    ).toEqual(['fork turn: expected one settled, got 0']);
  });
});
