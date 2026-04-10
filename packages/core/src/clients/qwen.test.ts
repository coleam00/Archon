import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

let capturedPrompt: string | undefined;
let capturedOptions: Record<string, unknown> | undefined;

const mockQuery = mock(async function* ({
  prompt,
  options,
}: {
  prompt: string;
  options?: Record<string, unknown>;
}) {
  capturedPrompt = prompt;
  capturedOptions = options;

  yield {
    kind: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Qwen smoke test response' }],
    },
  };

  yield {
    kind: 'result',
    session_id: 'qwen-session-1',
    usage: {
      input_tokens: 7,
      output_tokens: 3,
    },
  };
});

mock.module('@qwen-code/sdk', () => ({
  query: mockQuery,
  isSDKAssistantMessage: (message: { kind?: string }) => message.kind === 'assistant',
  isSDKPartialAssistantMessage: (message: { kind?: string }) =>
    message.kind === 'partial-assistant',
  isSDKResultMessage: (message: { kind?: string }) => message.kind === 'result',
  isSDKSystemMessage: (message: { kind?: string }) => message.kind === 'system',
}));

const mockLoadConfig = mock(async () => ({
  assistant: 'qwen',
  assistants: {
    claude: {},
    codex: {},
    qwen: {
      model: 'qwen-max',
      pathToQwenExecutable: '/opt/qwen',
      permissionMode: 'plan',
      authType: 'qwen-oauth',
      includePartialMessages: false,
    },
  },
  envVars: {
    ARCHON_HOME: '/tmp/archon',
  },
  allowTargetRepoKeys: true,
}));

mock.module('../config/config-loader', () => ({
  loadConfig: mockLoadConfig,
}));

mock.module('../db/codebases', () => ({
  findCodebaseByDefaultCwd: mock(async () => null),
  findCodebaseByPathPrefix: mock(async () => null),
}));

import { QwenClient } from './qwen';

describe('QwenClient smoke test', () => {
  beforeEach(() => {
    capturedPrompt = undefined;
    capturedOptions = undefined;
    mockQuery.mockClear();
    mockLoadConfig.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  test('streams assistant text and result while passing qwen config through', async () => {
    const client = new QwenClient();
    const chunks = [];

    for await (const chunk of client.sendQuery('smoke prompt', '/workspace')) {
      chunks.push(chunk);
    }

    expect(capturedPrompt).toBe('smoke prompt');
    expect(capturedOptions).toMatchObject({
      cwd: '/workspace',
      model: 'qwen-max',
      pathToQwenExecutable: '/opt/qwen',
      permissionMode: 'plan',
      authType: 'qwen-oauth',
      includePartialMessages: false,
      env: {
        ARCHON_HOME: '/tmp/archon',
      },
    });
    expect(chunks).toEqual([
      { type: 'assistant', content: 'Qwen smoke test response' },
      {
        type: 'result',
        sessionId: 'qwen-session-1',
        tokens: {
          input: 7,
          output: 3,
        },
      },
    ]);
  });

  test('does not force an auth type when qwen auth is not configured', async () => {
    mockLoadConfig.mockImplementationOnce(async () => ({
      assistant: 'qwen',
      assistants: {
        claude: {},
        codex: {},
        qwen: {
          model: 'qwen-max',
          includePartialMessages: true,
        },
      },
      envVars: {},
      allowTargetRepoKeys: true,
    }));

    const client = new QwenClient();

    for await (const _chunk of client.sendQuery('auth smoke prompt', '/workspace')) {
      // Drain stream
    }

    expect(capturedOptions).toMatchObject({
      cwd: '/workspace',
      model: 'qwen-max',
      includePartialMessages: true,
    });
    expect(capturedOptions).not.toHaveProperty('authType');
  });

  test('does not duplicate tool calls when partial streaming emits tool start first', async () => {
    mockQuery.mockImplementationOnce(async function* ({
      prompt,
      options,
    }: {
      prompt: string;
      options?: Record<string, unknown>;
    }) {
      capturedPrompt = prompt;
      capturedOptions = options;

      yield {
        kind: 'partial-assistant',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'tool-1',
            name: 'read_file',
            input: { path: 'README.md' },
          },
        },
      };

      yield {
        kind: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
          ],
        },
      };

      yield {
        kind: 'result',
        session_id: 'qwen-session-2',
        usage: {
          input_tokens: 4,
          output_tokens: 2,
        },
      };
    });

    const client = new QwenClient();
    const chunks = [];

    for await (const chunk of client.sendQuery('tool prompt', '/workspace')) {
      chunks.push(chunk);
    }

    expect(chunks.filter(chunk => chunk.type === 'tool')).toHaveLength(1);
    expect(chunks).toEqual([
      {
        type: 'tool',
        toolName: 'read_file',
        toolInput: { path: 'README.md' },
        toolCallId: 'tool-1',
      },
      {
        type: 'tool_result',
        toolName: 'read_file',
        toolOutput: 'done',
        toolCallId: 'tool-1',
      },
      {
        type: 'result',
        sessionId: 'qwen-session-2',
        tokens: {
          input: 4,
          output: 2,
        },
      },
    ]);
  });
});
