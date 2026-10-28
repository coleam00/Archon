// @archon-test-isolated
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import type { IAgentProvider, MessageChunk } from '@archon/provider-contract';
import { connectProvider, serveProvider, streamPair } from '@archon/provider-contract/plugin';
import { descriptor as codexDescriptor } from '@archon/providers/codex/descriptor';
import type { DagNode } from '../schemas';
import { executeDagWorkflow } from '../dag-executor';
import {
  createMockDeps,
  createMockPlatform,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  mockCodexCapabilities,
  persistedEvents,
} from './test-utils';

const idleTimeout = 30;
const liveWork = {
  subtask: {
    start: { type: 'subtask', taskId: 'command:stuck', status: 'started' },
    end: { type: 'subtask', taskId: 'command:stuck', status: 'completed' },
  },
  tool: {
    start: { type: 'tool_call', toolCallId: 'call', name: 'bash' },
    end: { type: 'tool_call_update', toolCallId: 'call', status: 'completed' },
  },
} satisfies Record<string, { start: MessageChunk; end: MessageChunk }>;

// The fallback makes the old unbounded exemption fail an assertion without hanging the test.
async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>(resolve => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, idleTimeout * 5);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}

describe('post-result turn settlement timeout', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'post-result-timeout-'));
  });
  afterEach(async () => {
    await removeTempTree(cwd);
  });

  async function run(
    kind: 'agent' | 'loop',
    sendQuery: IAgentProvider['sendQuery'],
    structured = false
  ) {
    const store = createMockStore();
    const base = {
      id: 'work',
      provider: 'codex',
      idle_timeout: idleTimeout,
      retry: { max_attempts: 0 },
      ...(structured
        ? {
            output_format: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
            },
          }
        : {}),
    };
    const node: DagNode =
      kind === 'agent'
        ? { ...base, kind, source: { kind: 'inline', prompt: 'Work.' } }
        : {
            ...base,
            kind,
            loop: { prompt: 'Work.', until: 'COMPLETE', max_iterations: 1, fresh_context: false },
          };
    await executeDagWorkflow(
      dagOptions({
        cwd,
        deps: {
          ...createMockDeps(store),
          getAgentProvider: () => ({
            sendQuery,
            checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
            getType: () => 'codex',
            getCapabilities: mockCodexCapabilities,
          }),
        },
        platform: createMockPlatform(),
        workflow: { name: 'settlement-timeout', nodes: [node] },
        workflowRun: makeWorkflowRun(),
      })
    );
    return store;
  }

  for (const kind of ['agent', 'loop'] as const) {
    it.each(['first', 'second'] as const)(
      `${kind}: fails a Codex plugin with live work that never settles after its %s result`,
      async result => {
        const pair = streamPair();
        let aborted = false;
        const serving = serveProvider(
          {
            descriptor: codexDescriptor,
            create: () => ({
              getType: () => 'codex',
              getCapabilities: mockCodexCapabilities,
              checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
              async *sendQuery(_prompt, _cwd, _session, options) {
                if (result === 'second') {
                  yield { type: 'result', structuredOutput: { ok: true } };
                  yield { type: 'state_update', state: 'running' };
                }
                yield liveWork.subtask.start;
                yield { type: 'result', structuredOutput: { ok: true } };
                await waitForAbort(options?.abortSignal);
                aborted = options?.abortSignal?.aborted ?? false;
              },
            }),
          },
          pair.provider
        );
        const client = await connectProvider(pair.host);
        try {
          const store = await run(kind, client.sendQuery.bind(client), true);
          const failure = persistedEvents(store).find(event => event.event_type === 'node_failed');
          expect(failure?.data?.failure_kind).toBe('timeout');
          expect(failure?.data?.error).toContain(
            "waiting for turn settlement after result from provider 'codex'"
          );
          expect(failure?.data?.error).toContain('command:stuck');
          expect(store.completeWorkflowRun).not.toHaveBeenCalled();
        } finally {
          await client.close();
          await serving;
        }
        expect(aborted).toBe(true);
      }
    );

    for (const transport of ['native', 'plugin'] as const) {
      for (const output of ['prose', 'silent', 'structured'] as const) {
        it(`${kind}: rejects ${transport} settlement without a result (${output})`, async () => {
          const sendQuery: IAgentProvider['sendQuery'] = async function* () {
            if (output === 'prose')
              yield { type: 'agent_message_chunk', text: 'Done. <promise>COMPLETE</promise>' };
            yield { type: 'settled' };
          };
          const pair = streamPair();
          const serving =
            transport === 'plugin'
              ? serveProvider(
                  {
                    descriptor: codexDescriptor,
                    create: () => ({
                      getType: () => 'codex',
                      getCapabilities: mockCodexCapabilities,
                      checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
                      sendQuery,
                    }),
                  },
                  pair.provider
                )
              : undefined;
          const client = transport === 'plugin' ? await connectProvider(pair.host) : undefined;
          try {
            const store = await run(
              kind,
              client ? client.sendQuery.bind(client) : sendQuery,
              output === 'structured'
            );
            const failure = persistedEvents(store).find(
              event => event.event_type === 'node_failed'
            );
            expect(failure?.data?.error).toContain("provider 'codex' sent settled before result");
            expect(store.completeWorkflowRun).not.toHaveBeenCalled();
          } finally {
            await client?.close();
            await serving;
          }
        });
      }
    }

    for (const [work, chunks] of Object.entries(liveWork)) {
      for (const wake of ['running', 'work start', 'running and work start'] as const) {
        it(`${kind}: rejects settlement using a result before the latest wake (${work}, ${wake})`, async () => {
          const store = await run(
            kind,
            async function* () {
              if (wake === 'running') yield chunks.start;
              yield {
                type: 'result',
                text: 'Done. <promise>COMPLETE</promise>',
                structuredOutput: { ok: true },
              };
              if (wake !== 'work start') yield { type: 'state_update', state: 'running' };
              if (wake !== 'running') yield chunks.start;
              yield chunks.end;
              yield { type: 'settled' };
            },
            true
          );
          const events = persistedEvents(store);
          const failure = events.find(event => event.event_type === 'node_failed');
          expect(failure?.data?.error).toContain("provider 'codex' sent settled before result");
          expect(events.some(event => event.event_type === 'node_completed')).toBe(false);
          expect(store.completeWorkflowRun).not.toHaveBeenCalled();
        });

        it(`${kind}: protects quiet ${work} in a later wake turn (${wake})`, async () => {
          let aborted = false;
          const store = await run(kind, async function* (_prompt, _cwd, _session, options) {
            if (wake === 'running') yield chunks.start;
            yield { type: 'result', text: 'Waiting.' };
            if (wake !== 'work start') yield { type: 'state_update', state: 'running' };
            if (wake !== 'running') yield chunks.start;
            await waitForAbort(options?.abortSignal);
            aborted = options?.abortSignal?.aborted ?? false;
            yield chunks.end;
            yield { type: 'result', text: 'Done. <promise>COMPLETE</promise>' };
            yield { type: 'settled' };
          });
          expect(aborted).toBe(false);
          expect(store.completeWorkflowRun).toHaveBeenCalled();
        });
      }

      for (const output of [
        'prose',
        'valid payload',
        'missing payload',
        'invalid payload',
      ] as const) {
        it(`${kind}: aborts silent ${work} after a result with ${output}`, async () => {
          let aborted = false;
          const store = await run(
            kind,
            async function* (_prompt, _cwd, _session, options) {
              yield chunks.start;
              if (output === 'prose')
                yield { type: 'agent_message_chunk', text: 'Done. <promise>COMPLETE</promise>' };
              yield {
                type: 'result',
                structuredOutput:
                  output === 'valid payload'
                    ? { ok: true }
                    : output === 'invalid payload'
                      ? { ok: 'invalid' }
                      : undefined,
              };
              await waitForAbort(options?.abortSignal);
              aborted = options?.abortSignal?.aborted ?? false;
              yield chunks.end;
              yield { type: 'settled' };
            },
            output !== 'prose'
          );
          expect(aborted).toBe(true);
          const events = persistedEvents(store);
          const failure = events.find(event => event.event_type === 'node_failed');
          expect(failure?.data?.failure_kind).toBe('timeout');
          expect(failure?.data?.error).toContain(
            "waiting for turn settlement after result from provider 'codex'"
          );
          expect(failure?.data?.error).toContain("from chunk type 'result'");
          if (work === 'subtask') expect(failure?.data?.error).toContain('command:stuck');
          expect(events.some(event => event.event_type === 'node_completed')).toBe(false);
          expect(store.completeWorkflowRun).not.toHaveBeenCalled();
        });
      }

      it(`${kind}: allows quiet live ${work} before a result`, async () => {
        let aborted = false;
        const store = await run(kind, async function* (_prompt, _cwd, _session, options) {
          yield chunks.start;
          await waitForAbort(options?.abortSignal);
          aborted = options?.abortSignal?.aborted ?? false;
          yield chunks.end;
          yield { type: 'agent_message_chunk', text: 'Done. <promise>COMPLETE</promise>' };
          yield { type: 'result' };
          yield { type: 'settled' };
        });
        expect(aborted).toBe(false);
        expect(store.completeWorkflowRun).toHaveBeenCalled();
      });

      it(`${kind}: succeeds when ${work} ends and the turn settles after a result`, async () => {
        const store = await run(kind, async function* () {
          yield chunks.start;
          yield { type: 'agent_message_chunk', text: 'Done. <promise>COMPLETE</promise>' };
          yield { type: 'result' };
          await Bun.sleep(5);
          yield chunks.end;
          yield { type: 'settled' };
        });
        expect(store.completeWorkflowRun).toHaveBeenCalled();
        expect(persistedEvents(store).some(event => event.event_type === 'node_failed')).toBe(
          false
        );
      });
    }
  }
});
