import { describe, expect, test } from 'bun:test';

import { hydrateMessages } from './WorkflowLogs';
import type { MessageResponse } from '@/lib/api';
import type { ToolEvent } from './WorkflowExecution';

const RUN_STARTED_AT = Date.parse('2026-07-02T07:10:11.000Z');
const TOOL_STARTED_AT = Date.parse('2026-07-02T07:23:12.000Z');
const RUN_CANCELLED_AT = Date.parse('2026-07-03T04:45:33.000Z');

function message(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'assistant',
    content: '',
    metadata: '{}',
    user_id: null,
    created_at: new Date(TOOL_STARTED_AT).toISOString(),
    ...overrides,
  };
}

function toolEvent(overrides: Partial<ToolEvent> = {}): ToolEvent {
  return {
    id: 'tool-1',
    name: "/bin/zsh -lc 'bun test ./apps/gateway/src/ws/gateway-server.test.ts'",
    input: {},
    stepName: 'dev-story',
    createdAt: new Date(TOOL_STARTED_AT).toISOString(),
    ...overrides,
  };
}

describe('hydrateMessages', () => {
  test('settles unattached open tool events for cancelled workflows', () => {
    const messages = hydrateMessages(
      [],
      RUN_STARTED_AT,
      [toolEvent()],
      'cancelled',
      RUN_CANCELLED_AT
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].toolCalls?.[0]).toMatchObject({
      id: 'tool-1',
      status: 'cancelled',
      duration: RUN_CANCELLED_AT - TOOL_STARTED_AT,
    });
  });

  test('keeps open tool events running while workflow is active', () => {
    const messages = hydrateMessages([], RUN_STARTED_AT, [toolEvent()], 'running');

    expect(messages).toHaveLength(1);
    const tool = messages[0].toolCalls?.[0];
    expect(tool?.id).toBe('tool-1');
    expect(tool?.duration).toBeUndefined();
    expect(tool?.status).toBeUndefined();
  });

  test('settles persisted open metadata tools for cancelled workflows', () => {
    const messages = hydrateMessages(
      [
        message({
          metadata: JSON.stringify({
            toolCalls: [{ name: 'bash', input: { command: 'bun test' } }],
          }),
        }),
      ],
      RUN_STARTED_AT,
      undefined,
      'cancelled',
      RUN_CANCELLED_AT
    );

    expect(messages[0].toolCalls?.[0]).toMatchObject({
      name: 'bash',
      input: { command: 'bun test' },
      status: 'cancelled',
      duration: RUN_CANCELLED_AT - TOOL_STARTED_AT,
    });
  });
});
