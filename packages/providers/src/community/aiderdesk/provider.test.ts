// Mock logger — must be set up before importing any @archon/paths consumer
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Logger } from 'pino';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
} as unknown as Logger;

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { AiderDeskProvider, translateProjectDir } from './provider';
import { AIDERDESK_CAPABILITIES } from './capabilities';
import { AiderDeskClient, parseSseFrame, type FetchFn } from './client';
import { AiderDeskApiError } from './errors';
import {
  InvalidAiderDeskModelOverrideError,
  UnknownAiderDeskAgentProfileError,
} from './errors';
import type {
  AiderDeskModel,
  AiderDeskProfile,
  AiderDeskSseEvent,
  AiderDeskTask,
  AiderDeskTaskFull,
} from './types';

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build an AiderDesk agent catalog shaped like the live host's 6-agent
 * profile response. All six agents share `(provider=poe, model=minimax-m3)`
 * so the resolver must rely on `name` (case-sensitive) for exact match.
 */
const POE_AGENT_ID = '16059d20-60b9-481a-8685-28cceeb3cfe5';
const INSPECTOR_AGENT_ID = 'c81d73ef-0000-0000-0000-000000000001';
const CODENOMICRON_AGENT_ID = 'f166ebd8-0000-0000-0000-000000000002';

const POE_PROFILE: AiderDeskProfile = {
  id: POE_AGENT_ID,
  name: 'Poe',
  provider: 'poe',
  model: 'minimax-m3',
  ruleFiles: ['/home/lfontanez/.aider-desk/agents/poe/rules/archon.md'],
};

const LIVE_CATALOG: AiderDeskProfile[] = [
  POE_PROFILE,
  {
    id: INSPECTOR_AGENT_ID,
    name: 'Inspector',
    provider: 'poe',
    model: 'minimax-m3',
    ruleFiles: ['/home/lfontanez/.aider-desk/agents/inspector/rules/archon.md'],
  },
  {
    id: CODENOMICRON_AGENT_ID,
    name: 'Codenomicron',
    provider: 'poe',
    model: 'minimax-m3',
    ruleFiles: [],
  },
  {
    id: 'aider-power-tools',
    name: 'Aider with Power Search',
    provider: 'poe',
    model: 'minimax-m3',
    ruleFiles: [],
  },
  { id: 'aider', name: 'Aider', provider: 'poe', model: 'minimax-m3', ruleFiles: [] },
  {
    id: 'default',
    name: 'Power Tools',
    provider: 'poe',
    model: 'minimax-m3',
    ruleFiles: [],
  },
];

function agentProfilesResponse(agents: AiderDeskProfile[] = LIVE_CATALOG): Response {
  return jsonResponse(agents);
}

/** Build a synthetic /api/models response. */
function modelsResponse(models: AiderDeskModel[] = []): Response {
  return jsonResponse({ models });
}

/** Build a mock task full response — used by tests that load tasks for message
 *  inspection (e.g. resume scenarios). Most tests now mock the bind / stream
 *  roundtrip directly and skip the messages-roundtrip shape entirely. */
function mockTaskFull(overrides: Partial<AiderDeskTaskFull> = {}): AiderDeskTaskFull {
  return {
    id: 'task-123',
    name: 'Test Task',
    state: 'READY_FOR_REVIEW',
    workingMode: 'local',
    currentMode: 'code',
    mainModel: null,
    provider: null,
    model: null,
    agentProfileId: null,
    reasoningEffort: null,
    thinkingTokens: null,
    parentId: null,
    archived: false,
    baseDir: '/test',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
    interruptedAt: null,
    aiderTotalCost: 0,
    agentTotalCost: 0,
    lastAgentProviderMetadata: null,
    messages: [],
    files: [],
    todoItems: [],
    question: null,
    ...overrides,
  };
}

function mockTaskRow(overrides: Partial<AiderDeskTask> = {}): AiderDeskTask {
  return {
    id: 'task-123',
    name: 'Test Task',
    state: 'TODO',
    workingMode: 'local',
    currentMode: 'code',
    mainModel: null,
    provider: null,
    model: null,
    agentProfileId: null,
    reasoningEffort: null,
    thinkingTokens: null,
    parentId: null,
    archived: false,
    baseDir: '/test',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    completedAt: null,
    interruptedAt: null,
    aiderTotalCost: 0,
    agentTotalCost: 0,
    lastAgentProviderMetadata: null,
    ...overrides,
  };
}

/** Collect all chunks from an async generator. */
async function collectChunks(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Build a synthetic Response whose body is a stream of SSE frames. */
function sseResponse(events: AiderDeskSseEvent[], contentType = 'text/event-stream'): Response {
  const text = events
    .map(ev => {
      const name = ev.kind;
      const payload =
        name === 'task-updated'
          ? ev.task
          : Object.fromEntries(Object.entries(ev).filter(([k]) => k !== 'kind'));
      const dataStr = JSON.stringify(payload);
      return `event: ${name}\ndata: ${dataStr}\n\n`;
    })
    .join('');
  const encoded = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': contentType },
  });
}

/** Build a synthetic JSON Response (for non-streaming endpoints). */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Recorder = {
  fetch: FetchFn;
  calls: Array<{ url: string; init?: RequestInit }>;
};
function recorder(): Recorder {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: url as string, init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as FetchFn;
  return { fetch: fetchImpl, calls };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('AiderDeskProvider', () => {
  let rec: Recorder;
  beforeEach(() => {
    rec = recorder();
  });

  describe('getType', () => {
    it('returns "aiderdesk"', () => {
      const provider = new AiderDeskProvider();
      expect(provider.getType()).toBe('aiderdesk');
    });
  });

  describe('getCapabilities', () => {
    it('returns AIDERDESK_CAPABILITIES', () => {
      const provider = new AiderDeskProvider();
      expect(provider.getCapabilities()).toBe(AIDERDESK_CAPABILITIES);
    });

    it('has sessionResume: true', () => {
      expect(AIDERDESK_CAPABILITIES.sessionResume).toBe(true);
    });

    it('has structuredOutput: best-effort', () => {
      expect(AIDERDESK_CAPABILITIES.structuredOutput).toBe('best-effort');
    });

    it('has nativeTools: false', () => {
      expect(AIDERDESK_CAPABILITIES.nativeTools).toBe(false);
    });

    it('has containerExec: false', () => {
      expect(AIDERDESK_CAPABILITIES.containerExec).toBe(false);
    });
  });

  describe('sendQuery — strict profile-name resolution', () => {
    /**
     * Build a single-profile catalog containing only `Aider` so Cases A / B
     * can assert against a deterministic profile id without consulting the
     * LIVE_CATALOG tiebreaker rules. The catalog here doesn't need to model
     * any production shape — it only needs to contain a Profile with
     * `name === 'Aider'`.
     */
    const AIDER_PROFILE: AiderDeskProfile = {
      id: 'aider-uuid-fixture',
      name: 'Aider',
      provider: 'poe',
      model: 'minimax-m3',
      ruleFiles: [],
    };

    /**
     * Case A: `model: 'Aider'` matches a profile by name → sends
     *   `agentProfileId=<id>`, NO `mainModel` simultaneously
     *   (`updateBody.mainModel === undefined`). AiderDesk uses the profile
     *   default model.
     */
    it('Case A: model name "Aider" → binds agentProfileId only, omits mainModel', async () => {
      const bodyRecorder: Array<{ url: string; body?: string }> = [];
      const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        bodyRecorder.push({ url: url as string, body: init?.body as string | undefined });
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/agent-profiles')) {
          return agentProfilesResponse([AIDER_PROFILE]);
        }
        if (u.endsWith('/models')) return modelsResponse();
        if (u.endsWith('/project/tasks') && init?.method === 'POST') {
          const body = init.body ? JSON.parse(init.body as string) : {};
          return jsonResponse({ ...mockTaskRow(), ...body.updates });
        }
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'ok' },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const bind = bodyRecorder.find(r => r.url.endsWith('/project/tasks'));
      expect(bind).toBeDefined();
      const body = JSON.parse(bind!.body as string);
      // Case A assertion: agentProfileId set, mainModel OMITTED.
      expect(body.updates.agentProfileId).toBe('aider-uuid-fixture');
      expect(body.updates.mainModel).toBeUndefined();
      expect(body.updates.currentMode).toBe('agent');
    });

    /**
     * Case B: `model: 'Aider' + modelOverride: 'poe/minimax-m3'` against the
     *   AIDER_PROFILE-only catalog → sends BOTH fields. The /api/models
     *   fetch validates the override.
     */
    it('Case B: model name "Aider" + modelOverride → binds BOTH agentProfileId and mainModel', async () => {
      const bodyRecorder: Array<{ url: string; body?: string }> = [];
      const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        bodyRecorder.push({ url: url as string, body: init?.body as string | undefined });
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/agent-profiles')) {
          return agentProfilesResponse([AIDER_PROFILE]);
        }
        if (u.endsWith('/models')) {
          // Catalog must contain the override for the bind to succeed.
          return modelsResponse([
            { id: 'minimax-m3', providerId: 'poe' },
            { id: 'qwen3-coder:30b', providerId: 'ollama' },
          ]);
        }
        if (u.endsWith('/project/tasks') && init?.method === 'POST') {
          const body = init.body ? JSON.parse(init.body as string) : {};
          return jsonResponse({ ...mockTaskRow(), ...body.updates });
        }
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'ok' },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'Aider',
          modelOverride: 'poe/minimax-m3',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const bind = bodyRecorder.find(r => r.url.endsWith('/project/tasks'));
      expect(bind).toBeDefined();
      const body = JSON.parse(bind!.body as string);
      expect(body.updates.agentProfileId).toBe('aider-uuid-fixture');
      expect(body.updates.mainModel).toBe('poe/minimax-m3');
    });

    /**
     * Case C: `model: 'NoSuchProfile'` → throws
     *   `UnknownAiderDeskAgentProfileError`, no SSE stream started.
     */
    it('Case C: model name "NoSuchProfile" → throws UnknownAiderDeskAgentProfileError', async () => {
      let ranPrompt = false;
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          ranPrompt = true;
          return sseResponse([]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });

      await expect(
        collectChunks(
          provider.sendQuery('hi', '/test', undefined, {
            model: 'NoSuchProfile',
            env: { AIDERDESK_API_URL: 'http://localhost:24337' },
          })
        )
      ).rejects.toThrow(UnknownAiderDeskAgentProfileError);

      expect(ranPrompt).toBe(false);

      // Inspect the typed error fields.
      try {
        await collectChunks(
          provider.sendQuery('hi', '/test', undefined, {
            model: 'NoSuchProfile',
            env: { AIDERDESK_API_URL: 'http://localhost:24337' },
          })
        );
      } catch (error) {
        expect(error).toBeInstanceOf(UnknownAiderDeskAgentProfileError);
        const e = error as UnknownAiderDeskAgentProfileError;
        expect(e.requestedName).toBe('NoSuchProfile');
        expect(e.knownNames).toContain('Aider');
        expect(e.knownNames).toContain('Poe');
        expect(e.knownNames).toContain('Codenomicron');
      }
    });

    /**
     * Case D: `model: 'Aider' + modelOverride: 'garbage'` → throws
     *   `InvalidAiderDeskModelOverrideError` BEFORE the lookup-OK-then-
     *   override-validation-FAIL otherwise. We assert that the override is
     *   validated even when the profile name is valid.
     */
    it('Case D: model name valid + modelOverride garbage → throws InvalidAiderDeskModelOverrideError', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/models')) {
          return modelsResponse([{ id: 'minimax-m3', providerId: 'poe' }]);
        }
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) return sseResponse([]);
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });

      await expect(
        collectChunks(
          provider.sendQuery('hi', '/test', undefined, {
            model: 'Aider',
            modelOverride: 'poe/unsupported-model',
            env: { AIDERDESK_API_URL: 'http://localhost:24337' },
          })
        )
      ).rejects.toThrow(InvalidAiderDeskModelOverrideError);

      try {
        await collectChunks(
          provider.sendQuery('hi', '/test', undefined, {
            model: 'Aider',
            modelOverride: 'poe/unsupported-model',
            env: { AIDERDESK_API_URL: 'http://localhost:24337' },
          })
        );
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidAiderDeskModelOverrideError);
        const e = error as InvalidAiderDeskModelOverrideError;
        expect(e.model).toBe('poe/unsupported-model');
        expect(e.knownModels).toEqual(['poe/minimax-m3']);
      }
    });

    /**
     * Case E: missing `model` and no assistant pin → throws
     *   `UnknownAiderDeskAgentProfileError` with `.requestedName = ''` and
     *   candidates inferred from the typed fetch mock.
     */
    it('Case E: missing model + no assistant pin → throws UnknownAiderDeskAgentProfileError with requestedName=""', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) return sseResponse([]);
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });

      await expect(
        collectChunks(
          provider.sendQuery('hi', '/test', undefined, {
            env: { AIDERDESK_API_URL: 'http://localhost:24337' },
          })
        )
      ).rejects.toThrow(UnknownAiderDeskAgentProfileError);

      try {
        await collectChunks(
          provider.sendQuery('hi', '/test', undefined, {
            env: { AIDERDESK_API_URL: 'http://localhost:24337' },
          })
        );
      } catch (error) {
        const e = error as UnknownAiderDeskAgentProfileError;
        expect(e.requestedName).toBe('');
        expect(e.knownNames.length).toBe(LIVE_CATALOG.length);
      }
    });

    it('assistantConfig.agentProfileId pins the profile UUID and skips catalog fetch', async () => {
      const bodyRecorder: Array<{ url: string; body?: string }> = [];
      const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        bodyRecorder.push({ url: url as string, body: init?.body as string | undefined });
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/project/tasks') && init?.method === 'POST') {
          const body = init.body ? JSON.parse(init.body as string) : {};
          return jsonResponse({ ...mockTaskRow(), ...body.updates });
        }
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'ok' },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          // Even when catalog fetches would otherwise happen, the pin
          // suppresses them.
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
          assistantConfig: { agentProfileId: 'pinned-uuid-1' },
        })
      );

      // No catalog fetches.
      expect(bodyRecorder.some(r => r.url.endsWith('/agent-profiles'))).toBe(false);
      expect(bodyRecorder.some(r => r.url.endsWith('/models'))).toBe(false);

      const bind = bodyRecorder.find(r => r.url.endsWith('/project/tasks'));
      const body = JSON.parse(bind!.body as string);
      expect(body.updates.agentProfileId).toBe('pinned-uuid-1');
      expect(body.updates.mainModel).toBeUndefined();
    });

    it('uses SSE Accept header on /api/run-prompt', async () => {
      const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        rec.calls.push({ url: url as string, init });
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/models')) return modelsResponse();
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'ok' },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const runPromptCall = rec.calls.find(c => c.url.endsWith('/run-prompt'));
      expect(runPromptCall).toBeDefined();
      const headers = runPromptCall!.init!.headers as Record<string, string>;
      expect(headers.Accept).toBe('text/event-stream');
    });

    it('streams response-chunks through assistant MessageChunks', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/models')) return modelsResponse();
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            { kind: 'response-chunk', taskId: 't', messageId: 'm', chunk: 'hello' },
            { kind: 'response-chunk', taskId: 't', messageId: 'm', chunk: ' world' },
            { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'hello world' },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const assistants = chunks.filter((c: any) => c.type === 'assistant') as any[];
      expect(assistants.map(c => c.content)).toEqual(['hello', ' world']);
    });

    it('maps ask-question event to a system warning chunk', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/models')) return modelsResponse();
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            {
              kind: 'ask-question',
              taskId: 't',
              question: 'Which model should I use?',
              options: ['haiku', 'sonnet'],
            },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const systemChunks = chunks.filter((c: any) => c.type === 'system') as any[];
      expect(systemChunks.length).toBeGreaterThanOrEqual(1);
      expect(systemChunks[0].content).toContain('Which model should I use?');

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk.stopReason).toBe('awaiting_user_input');
    });

    it('maps completed tool event to a tool_result chunk', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/models')) return modelsResponse();
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            {
              kind: 'tool',
              taskId: 't',
              messageId: 'tool-call-1',
              toolName: 'bash',
              finished: true,
              result: '42\n',
            },
            { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'done' },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const toolResult = chunks.find((c: any) => c.type === 'tool_result') as any;
      expect(toolResult).toBeDefined();
      expect(toolResult.toolName).toBe('bash');
      expect(toolResult.toolOutput).toBe('42\n');
      expect(toolResult.toolCallId).toBe('tool-call-1');
    });

    it('throws when receiving an INTERRUPTED state via task-updated', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/models')) return modelsResponse();
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            { kind: 'task-updated', task: mockTaskRow({ state: 'INTERRUPTED' }) },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.isError).toBe(true);
      expect(resultChunk.stopReason).toBe('interrupted');
    });

    it('creates a new task and runs prompt when no resumeSessionId', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/models')) return modelsResponse();
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            {
              kind: 'response-completed',
              taskId: 'task-123',
              messageId: 'm',
              content: 'Hello from AiderDesk!',
            },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hello', '/test', undefined, {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      // Final result chunk with end_turn.
      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.sessionId).toBe('task-123');
      expect(resultChunk.isError).toBe(false);
      expect(resultChunk.stopReason).toBe('end_turn');
      // No resume was attempted → no `resumed` flag.
      expect(resultChunk.resumed).toBeUndefined();
    });

    it('resumes existing task when resumeSessionId is provided', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/load')) {
          return jsonResponse(mockTaskFull({ id: 'existing-task-id', state: 'IN_PROGRESS' }));
        }
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/models')) return modelsResponse();
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            {
              kind: 'response-completed',
              taskId: 'existing-task-id',
              messageId: 'm',
              content: 'Resumed!',
            },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('continue', '/test', 'existing-task-id', {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk.sessionId).toBe('existing-task-id');
      expect(resultChunk.resumed).toBe(true);
    });

    it('yields resume failure warning when loadTask fails', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/load')) return new Response('Not found', { status: 404 });
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/models')) return modelsResponse();
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            {
              kind: 'response-completed',
              taskId: 'task-123',
              messageId: 'm',
              content: 'Fresh start!',
            },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hello', '/test', 'bad-task-id', {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const systemChunks = chunks.filter((c: any) => c.type === 'system') as any[];
      expect(systemChunks.length).toBeGreaterThanOrEqual(1);
      expect(systemChunks[0].content).toContain('Could not resume');

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk.resumed).toBe(false);
    });

    it('yields error result when run-prompt returns a non-2xx response', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/models')) return modelsResponse();
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt'))
          return new Response('Internal Server Error', { status: 500 });
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hello', '/test', undefined, {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.isError).toBe(true);
    });

    it('handles structured output by augmenting prompt and parsing response', async () => {
      let capturedRunPromptBody: string | undefined;
      const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/models')) return modelsResponse();
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          capturedRunPromptBody = (init?.body as string) ?? '';
          return sseResponse([
            {
              kind: 'response-completed',
              taskId: 't',
              messageId: 'm',
              content: '{"answer": "42"}',
            },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
          outputFormat: {
            type: 'json_schema',
            schema: { type: 'object', properties: { answer: { type: 'string' } } },
          },
        })
      );

      expect(capturedRunPromptBody).toContain('Respond with ONLY a JSON object');
      expect(capturedRunPromptBody).toContain('\\"answer\\"');

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk.structuredOutput).toEqual({ answer: '42' });
    });

    it('yields result chunk with sessionId when assistant produced nothing', async () => {
      const recFetch: FetchFn = (async (url: string) => {
        const u = url as string;
        if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
        if (u.endsWith('/models')) return modelsResponse();
        if (u.endsWith('/project/tasks')) return jsonResponse(mockTaskRow());
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'silent' },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      const chunks = await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const resultChunk = chunks.find((c: any) => c.type === 'result') as any;
      expect(resultChunk).toBeDefined();
      expect(resultChunk.sessionId).toBe('task-123');
      expect(resultChunk.tokens).toBeUndefined();
    });

    it('cache: two sendQuery calls in quick succession → only one GET /agent-profiles', async () => {
      const calls: string[] = [];
      const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        calls.push(url as string);
        const u = url as string;
        if (u.endsWith('/project/tasks/new'))
          return jsonResponse(
            mockTaskRow({ id: `t-${calls.filter(c => c.endsWith('/project/tasks/new')).length}` })
          );
        if (u.endsWith('/agent-profiles')) return agentProfilesResponse();
        if (u.endsWith('/models')) return modelsResponse();
        if (u.endsWith('/project/tasks') && init?.method === 'POST') {
          const body = init.body ? JSON.parse(init.body as string) : {};
          return jsonResponse({ ...mockTaskRow(), ...body.updates });
        }
        if (u.endsWith('/run-prompt')) {
          return sseResponse([
            { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'ok' },
            { kind: 'stream-end' },
          ]);
        }
        return new Response('{}', { status: 200 });
      }) as FetchFn;

      const provider = new AiderDeskProvider({ fetchFn: recFetch });
      await collectChunks(
        provider.sendQuery('hi', '/test', undefined, {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );
      await collectChunks(
        provider.sendQuery('hi again', '/test', undefined, {
          model: 'Aider',
          env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        })
      );

      const profilesCalls = calls.filter(u => u.endsWith('/agent-profiles'));
      expect(profilesCalls.length).toBe(1);
    });
  });

  describe('parseSseFrame', () => {
    it('decodes a user-message frame', () => {
      const ev = parseSseFrame(
        'event: user-message\ndata: {"taskId":"t","baseDir":"/x","content":"hi"}'
      );
      expect(ev).toEqual({
        kind: 'user-message',
        taskId: 't',
        baseDir: '/x',
        content: 'hi',
      });
    });

    it('parses a response-chunk frame', () => {
      const ev = parseSseFrame(
        'event: response-chunk\ndata: {"taskId":"t","messageId":"m","chunk":"hello"}'
      );
      expect(ev?.kind).toBe('response-chunk');
      if (ev?.kind === 'response-chunk') {
        expect(ev.chunk).toBe('hello');
      }
    });

    it('treats stream-end as the terminal sentinel', () => {
      const ev = parseSseFrame('event: stream-end\ndata: {}');
      expect(ev).toEqual({ kind: 'stream-end' });
    });

    it('treats the conventional [DONE] sentinel as stream-end', () => {
      const ev = parseSseFrame('data: [DONE]');
      expect(ev).toEqual({ kind: 'stream-end' });
    });

    it('tolerates CRLF line endings', () => {
      const ev = parseSseFrame('event: stream-end\r\ndata: {}\r\n');
      expect(ev).toEqual({ kind: 'stream-end' });
    });

    it('falls back to event name "message" when event line is missing', () => {
      const ev = parseSseFrame('data: {"kind":"stream-end","extra":1}');
      expect(ev?.kind).toBe('unknown');
      if (ev?.kind === 'unknown') {
        expect(ev.eventName).toBe('message');
      }
    });

    it('returns null for empty / comment-only frames', () => {
      expect(parseSseFrame('')).toBeNull();
      expect(parseSseFrame(': keepalive')).toBeNull();
      expect(parseSseFrame('\n\n')).toBeNull();
    });

    it('returns unknown-kind with raw payload for non-JSON data', () => {
      const ev = parseSseFrame('event: weird\ndata: not-json');
      expect(ev?.kind).toBe('unknown');
      if (ev?.kind === 'unknown') {
        expect(ev.eventName).toBe('weird');
        expect(ev.payload).toBe('not-json');
      }
    });

    it('routes task-updated events with task cast as AiderDeskTask', () => {
      const payload = JSON.stringify({
        id: 't-1',
        name: 'n',
        state: 'TODO',
        workingMode: 'local',
        currentMode: 'code',
        mainModel: null,
        provider: null,
        model: null,
        agentProfileId: null,
        reasoningEffort: null,
        thinkingTokens: null,
        parentId: null,
        archived: false,
        baseDir: '/x',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        startedAt: null,
        completedAt: null,
        interruptedAt: null,
        aiderTotalCost: 0,
        agentTotalCost: 0,
        lastAgentProviderMetadata: null,
      });
      const ev = parseSseFrame(`event: task-updated\ndata: ${payload}`);
      expect(ev?.kind).toBe('task-updated');
    });

    it('routes ask-question events with options filtered to strings', () => {
      const ev = parseSseFrame(
        'event: ask-question\ndata: {"taskId":"t","question":"q","options":["a","b"]}'
      );
      expect(ev?.kind).toBe('ask-question');
      if (ev?.kind === 'ask-question') {
        expect(ev.question).toBe('q');
        expect(ev.options).toEqual(['a', 'b']);
      }
    });

    it('handles a tool frame with finished=true and result', () => {
      const ev = parseSseFrame(
        'event: tool\ndata: {"taskId":"t","messageId":"m","toolName":"bash","finished":true,"result":"ok"}'
      );
      expect(ev?.kind).toBe('tool');
      if (ev?.kind === 'tool') {
        expect(ev.toolName).toBe('bash');
        expect(ev.finished).toBe(true);
        expect(ev.result).toBe('ok');
      }
    });
  });

  describe('AiderDeskClient.updateTask', () => {
    it('POST /api/project/tasks with {projectDir, id, updates}', async () => {
      const rec5: Recorder = { calls: [], fetch: undefined as unknown as FetchFn };
      const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        rec5.calls.push({ url: url as string, init });
        return jsonResponse(mockTaskRow({ id: 't-1', mainModel: 'poe/minimax-m3' }));
      }) as FetchFn;
      rec5.fetch = recFetch;

      const client = new AiderDeskClient({
        apiUrl: 'http://localhost:24337',
        fetchFn: recFetch,
        timeoutMs: 5_000,
      });
      const updated = await client.updateTask('/proj', 't-1', {
        mainModel: 'poe/minimax-m3',
        currentMode: 'agent',
        workingMode: 'local',
      });

      expect(rec5.calls.length).toBe(1);
      expect(rec5.calls[0].url).toBe('http://localhost:24337/api/project/tasks');
      expect(rec5.calls[0].init?.method).toBe('POST');
      const body = JSON.parse(rec5.calls[0].init!.body as string);
      expect(body).toEqual({
        projectDir: '/proj',
        id: 't-1',
        updates: {
          mainModel: 'poe/minimax-m3',
          currentMode: 'agent',
          workingMode: 'local',
        },
      });
      expect(updated.mainModel).toBe('poe/minimax-m3');
    });
  });

  describe('AiderDeskClient.listAgentProfiles', () => {
    it('GET /api/agent-profiles returns parsed profile list', async () => {
      const rec6: Recorder = { calls: [], fetch: undefined as unknown as FetchFn };
      const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
        rec6.calls.push({ url: url as string, init });
        return jsonResponse([POE_PROFILE, { id: 'a2', name: 'Aider', provider: 'poe', model: 'minimax-m3' }]);
      }) as FetchFn;
      rec6.fetch = recFetch;

      const client = new AiderDeskClient({
        apiUrl: 'http://localhost:24337',
        fetchFn: recFetch,
        timeoutMs: 5_000,
      });
      const profiles = await client.listAgentProfiles();

      expect(rec6.calls.length).toBe(1);
      expect(rec6.calls[0].url).toBe('http://localhost:24337/api/agent-profiles');
      expect(rec6.calls[0].init?.method).toBe('GET');
      expect(profiles.length).toBe(2);
      expect(profiles[0].id).toBe(POE_AGENT_ID);
      expect(profiles[0].name).toBe('Poe');
    });
  });
});

describe('translateProjectDir', () => {
  // Process-env pollution guard.
  const ENV_KEY = 'AIDERDESK_PROJECT_DIR_REMAP';
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  it('identity: no env, no assistantConfig → returns cwd verbatim', () => {
    expect(translateProjectDir('/host/projects/orchestration-home', { remap: null })).toBe(
      '/host/projects/orchestration-home'
    );
    expect(translateProjectDir('/host/projects/orchestration-home')).toBe(
      '/host/projects/orchestration-home'
    );
  });

  it('exact-match remap: object form key matches cwd exactly → translated', () => {
    const remap = {
      '/host/projects/orchestration-home': '/home/lfontanez/dev/orchestration-home',
    };
    expect(
      translateProjectDir('/host/projects/orchestration-home', { remap, source: 'test' })
    ).toBe('/home/lfontanez/dev/orchestration-home');
  });

  it('prefix-remap: array form with regex anchor matches → translated', () => {
    const remap = [{ from: '^/host/projects/', to: '/home/lfontanez/dev/' }];
    expect(translateProjectDir('/host/projects/orchestration-home', { remap, source: 'test' })).toBe(
      '/home/lfontanez/dev/orchestration-home'
    );
    expect(translateProjectDir('/host/projects/anything-else', { remap, source: 'test' })).toBe(
      '/home/lfontanez/dev/anything-else'
    );
  });

  it('longest-match wins among multiple conflicting object-form entries', () => {
    const remap = {
      '/host/projects/': '/home/lfontanez/dev/',
      '/host/projects/orchestration-home': '/home/lfontanez/dev/orchestration-home',
    };
    expect(
      translateProjectDir('/host/projects/orchestration-home', { remap, source: 'test' })
    ).toBe('/home/lfontanez/dev/orchestration-home');
    expect(translateProjectDir('/host/projects/something-else', { remap, source: 'test' })).toBe(
      '/home/lfontanez/dev/something-else'
    );
  });

  it('process.env override beats assistantConfig (precedence.requestOptions.env > process.env > assistantConfig)', async () => {
    process.env[ENV_KEY] = JSON.stringify({
      '/host/projects/': '/home/lfontanez/dev/from-process-env/',
    });

    const rec: Recorder = { calls: [], fetch: undefined as unknown as FetchFn };
    const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
      rec.calls.push({ url: url as string, init });
      const u = url as string;
      if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
      if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
      if (u.endsWith('/models')) return modelsResponse();
      if (u.endsWith('/project/tasks') && init?.method === 'POST') {
        const body = init.body ? JSON.parse(init.body as string) : {};
        return jsonResponse({ ...mockTaskRow(), ...body.updates });
      }
      if (u.endsWith('/run-prompt')) {
        return sseResponse([
          { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'ok' },
          { kind: 'stream-end' },
        ]);
      }
      return new Response('{}', { status: 200 });
    }) as FetchFn;
    rec.fetch = recFetch;

    const provider = new AiderDeskProvider({ fetchFn: recFetch });
    await collectChunks(
      provider.sendQuery('hi', '/host/projects/orchestration-home', undefined, {
        model: 'Aider',
        env: { AIDERDESK_API_URL: 'http://localhost:24337' },
        assistantConfig: {
          projectDirRemap: { '/host/projects/': '/home/lfontanez/dev/from-assistant-config/' },
        },
      })
    );

    const runPromptCall = rec.calls.find(c => c.url.endsWith('/run-prompt'));
    expect(runPromptCall).toBeDefined();
    const runPromptBody = JSON.parse(runPromptCall!.init!.body as string);
    expect(runPromptBody.projectDir).toBe(
      '/home/lfontanez/dev/from-process-env/orchestration-home'
    );

    const updateCall = rec.calls.find(
      c => c.url.endsWith('/project/tasks') && c.init?.method === 'POST'
    );
    expect(updateCall).toBeDefined();
    const updateBody = JSON.parse(updateCall!.init!.body as string);
    expect(updateBody.projectDir).toBe(
      '/home/lfontanez/dev/from-process-env/orchestration-home'
    );
  });

  it('requestOptions.env override beats both process.env and assistantConfig', async () => {
    process.env[ENV_KEY] = JSON.stringify({
      '/host/projects/': '/home/lfontanez/dev/from-process-env/',
    });

    const rec: Recorder = { calls: [], fetch: undefined as unknown as FetchFn };
    const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
      rec.calls.push({ url: url as string, init });
      const u = url as string;
      if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
      if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
      if (u.endsWith('/models')) return modelsResponse();
      if (u.endsWith('/project/tasks') && init?.method === 'POST') {
        const body = init.body ? JSON.parse(init.body as string) : {};
        return jsonResponse({ ...mockTaskRow(), ...body.updates });
      }
      if (u.endsWith('/run-prompt')) {
        return sseResponse([
          { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'ok' },
          { kind: 'stream-end' },
        ]);
      }
      return new Response('{}', { status: 200 });
    }) as FetchFn;
    rec.fetch = recFetch;

    const provider = new AiderDeskProvider({ fetchFn: recFetch });
    await collectChunks(
      provider.sendQuery('hi', '/host/projects/orchestration-home', undefined, {
        model: 'Aider',
        env: {
          AIDERDESK_API_URL: 'http://localhost:24337',
          AIDERDESK_PROJECT_DIR_REMAP: JSON.stringify({
            '/host/projects/': '/home/lfontanez/dev/from-request-options-env/',
          }),
        },
        assistantConfig: {
          projectDirRemap: { '/host/projects/': '/home/lfontanez/dev/from-assistant-config/' },
        },
      })
    );

    const runPromptCall = rec.calls.find(c => c.url.endsWith('/run-prompt'));
    expect(runPromptCall).toBeDefined();
    const runPromptBody = JSON.parse(runPromptCall!.init!.body as string);
    expect(runPromptBody.projectDir).toBe(
      '/home/lfontanez/dev/from-request-options-env/orchestration-home'
    );
  });

  it('malformed JSON in env: identity result + single warn chunk over the SSE stream', async () => {
    process.env[ENV_KEY] = 'this is not json {{';

    const rec: Recorder = { calls: [], fetch: undefined as unknown as FetchFn };
    const recFetch: FetchFn = (async (url: string, init?: RequestInit) => {
      rec.calls.push({ url: url as string, init });
      const u = url as string;
      if (u.endsWith('/project/tasks/new')) return jsonResponse(mockTaskRow());
      if (u.endsWith('/agent-profiles')) return agentProfilesResponse(LIVE_CATALOG);
      if (u.endsWith('/models')) return modelsResponse();
      if (u.endsWith('/project/tasks') && init?.method === 'POST') {
        const body = init.body ? JSON.parse(init.body as string) : {};
        return jsonResponse({ ...mockTaskRow(), ...body.updates });
      }
      if (u.endsWith('/run-prompt')) {
        return sseResponse([
          { kind: 'response-completed', taskId: 't', messageId: 'm', content: 'ok' },
          { kind: 'stream-end' },
        ]);
      }
      return new Response('{}', { status: 200 });
    }) as FetchFn;
    rec.fetch = recFetch;

    const provider = new AiderDeskProvider({ fetchFn: recFetch });
    const chunks = await collectChunks(
      provider.sendQuery('hi', '/host/projects/orchestration-home', undefined, {
        model: 'Aider',
        env: { AIDERDESK_API_URL: 'http://localhost:24337' },
      })
    );

    const warns = chunks.filter(
      (c: any) =>
        c.type === 'system' &&
        typeof c.content === 'string' &&
        c.content.includes('AiderDesk projectDir-remap env is not valid JSON')
    );
    expect(warns.length).toBe(1);
    expect((warns[0] as any).content).toContain('Supported shapes');

    const runPromptCall = rec.calls.find(c => c.url.endsWith('/run-prompt'));
    expect(runPromptCall).toBeDefined();
    const runPromptBody = JSON.parse(runPromptCall!.init!.body as string);
    expect(runPromptBody.projectDir).toBe('/host/projects/orchestration-home');

    const updateCall = rec.calls.find(
      c => c.url.endsWith('/project/tasks') && c.init?.method === 'POST'
    );
    const updateBody = JSON.parse(updateCall!.init!.body as string);
    expect(updateBody.projectDir).toBe('/host/projects/orchestration-home');
  });
});

// Touch the AiderDeskApiError export so consumers can import-class-check it
// without leaving a tree-shaking warning.
void AiderDeskApiError;
