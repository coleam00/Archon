import { expect } from 'bun:test';
import type {
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
} from '@agentclientprotocol/sdk';
import acp from '@agentclientprotocol/sdk/schema/schema.json';
import { z } from 'zod';
import {
  cancelNotificationSchema,
  initializeRequestSchema,
  initializeResponseSchema,
  newSessionRequestSchema,
  newSessionResponseSchema,
  promptRequestSchema,
  promptResponseSchema,
} from '../wire';

interface AcpLifecycle {
  InitializeRequest: InitializeRequest;
  InitializeResponse: InitializeResponse;
  NewSessionRequest: NewSessionRequest;
  NewSessionResponse: NewSessionResponse;
  PromptRequest: PromptRequest;
  PromptResponse: PromptResponse;
  CancelNotification: CancelNotification;
}

// Archon's lifecycle is a narrower ACP subset with required Archon metadata.
const wireSchemas = {
  InitializeRequest: initializeRequestSchema,
  InitializeResponse: initializeResponseSchema,
  NewSessionRequest: newSessionRequestSchema,
  NewSessionResponse: newSessionResponseSchema,
  PromptRequest: promptRequestSchema,
  PromptResponse: promptResponseSchema,
  CancelNotification: cancelNotificationSchema,
} satisfies { [K in keyof AcpLifecycle]: z.ZodType<AcpLifecycle[K]> };

export function checkAcp(name: keyof typeof wireSchemas, value: unknown): void {
  expect(wireSchemas[name].safeParse(value).success).toBe(true);
  // The upstream JSON includes nullable type arrays supported at runtime but absent
  // from zod's JSONSchema input type. Keep the SDK schema unchanged.
  const schema = z.fromJSONSchema({
    $ref: `#/$defs/${name}`,
    $defs: acp.$defs,
  } as unknown as Parameters<typeof z.fromJSONSchema>[0]);
  expect(schema.safeParse(value).success).toBe(true);
}
