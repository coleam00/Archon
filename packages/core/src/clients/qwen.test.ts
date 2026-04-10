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
});
