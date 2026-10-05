import { z } from 'zod';
import {
  executionContextSchema,
  systemPromptInputSchema,
  type SendQueryOptions,
} from '../agent-provider';
import { providerCapabilitiesSchema } from '../capabilities';
import { credentialStatusSchema } from '../credential-status';
import type { AssertNever } from '../effort';
import { providerChunkSchema } from '../events';
import { credentialSpecSchema } from '../registration';
import { providerStopReasonSchema, type ProviderStopReason } from '../result';

export const PROVIDER_PLUGIN_PROTOCOL = 1;
export const PROVIDER_PLUGIN_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export const providerPluginDescriptorSchema = z.object({
  protocol: z.literal(PROVIDER_PLUGIN_PROTOCOL),
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  displayName: z.string().min(1),
  version: z.string().min(1),
  capabilities: providerCapabilitiesSchema.extend({ nativeTools: z.literal(false) }),
  credentials: z.object({ kind: z.literal('static'), specs: z.array(credentialSpecSchema) }),
  configSchema: z.record(z.string(), z.json()),
  ownsUnprefixedModelRefs: z.literal(true).optional(),
});
export type ProviderPluginDescriptor = z.infer<typeof providerPluginDescriptorSchema>;

export const HOST_ONLY_REQUEST_KEYS = [
  'abortSignal',
  'nativeTools',
  'onAdmission',
  'env',
] as const satisfies readonly (keyof SendQueryOptions)[];
const configSchema = z.record(z.string(), z.json());
export const providerSessionRequestSchema = z.strictObject({
  prompt: z.string(),
  cwd: z.string().min(1),
  resumeSessionId: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: systemPromptInputSchema.optional(),
  outputFormat: z.object({ type: z.literal('json_schema'), schema: configSchema }).optional(),
  protectedEnvKeys: z.array(z.string()).readonly().optional(),
  maxBudgetUsd: z.number().optional(),
  fallbackModel: z.string().optional(),
  forkSession: z.boolean().optional(),
  purpose: z.literal('title-generation').optional(),
  nodeConfig: configSchema.optional(),
  assistantConfig: configSchema.optional(),
  execContext: executionContextSchema.optional(),
});
export type ProviderSessionRequest = z.infer<typeof providerSessionRequestSchema>;
export type RequestOptionCoverage = AssertNever<
  Exclude<
    keyof SendQueryOptions,
    keyof ProviderSessionRequest | (typeof HOST_ONLY_REQUEST_KEYS)[number]
  >
>;
export type RequestOptionNames = AssertNever<
  Exclude<
    keyof ProviderSessionRequest,
    keyof SendQueryOptions | 'prompt' | 'cwd' | 'resumeSessionId'
  >
>;
export type RequestOptionTypes = AssertNever<
  {
    [K in keyof SendQueryOptions]: K extends keyof ProviderSessionRequest
      ? ProviderSessionRequest[K] extends SendQueryOptions[K]
        ? never
        : K
      : never;
  }[keyof SendQueryOptions] &
    string
>;

export const initializeRequestSchema = z.object({
  protocolVersion: z.literal(1),
  clientCapabilities: z.object({
    fs: z.object({ readTextFile: z.literal(false), writeTextFile: z.literal(false) }),
    terminal: z.literal(false),
    _meta: z.object({ archon: z.object({ protocol: z.literal(PROVIDER_PLUGIN_PROTOCOL) }) }),
  }),
});
export const initializeResponseSchema = z.object({
  protocolVersion: z.literal(1),
  agentCapabilities: z.object({ _meta: z.object({ archon: providerPluginDescriptorSchema }) }),
  authMethods: z.array(z.never()),
});
export const newSessionRequestSchema = z.object({
  cwd: z.string().min(1),
  mcpServers: z.array(z.never()),
  _meta: z.object({ archon: z.object({ request: providerSessionRequestSchema }) }),
});
export const newSessionResponseSchema = z.object({ sessionId: z.string().min(1) });
export const promptRequestSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.tuple([z.object({ type: z.literal('text'), text: z.string() })]),
});
export const promptResponseSchema = z.object({ stopReason: providerStopReasonSchema });
export const cancelNotificationSchema = z.object({ sessionId: z.string().min(1) });
export const chunkNotificationSchema = cancelNotificationSchema.extend({
  chunk: providerChunkSchema,
});
export const checkCredentialRequestSchema = z.object({
  model: z.string().optional(),
  assistantConfig: configSchema.optional(),
});
export const resolveCredentialModelRequestSchema = checkCredentialRequestSchema.extend({
  cwd: z.string().min(1),
});
export const resolveCredentialModelResponseSchema = z.object({ model: z.string().optional() });

// ACP requires a stopReason even when the provider cannot report one. This response
// is lifecycle acknowledgement only; the host's result comes from the unchanged chunk.
export function acpStopReason(
  reason: ProviderStopReason | undefined,
  cancelled: boolean
): ProviderStopReason {
  return cancelled ? 'cancelled' : (reason ?? 'end_turn');
}

export const providerPluginWireSchemas = {
  ProviderPluginDescriptor: providerPluginDescriptorSchema,
  ProviderSessionRequest: providerSessionRequestSchema,
  ProviderInitializeRequest: initializeRequestSchema,
  ProviderInitializeResponse: initializeResponseSchema,
  ProviderNewSessionRequest: newSessionRequestSchema,
  ProviderNewSessionResponse: newSessionResponseSchema,
  ProviderPromptRequest: promptRequestSchema,
  ProviderPromptResponse: promptResponseSchema,
  ProviderCancelNotification: cancelNotificationSchema,
  ProviderChunkNotification: chunkNotificationSchema,
  ProviderCheckCredentialRequest: checkCredentialRequestSchema,
  ProviderCheckCredentialResponse: credentialStatusSchema,
  ProviderResolveCredentialModelRequest: resolveCredentialModelRequestSchema,
  ProviderResolveCredentialModelResponse: resolveCredentialModelResponseSchema,
};
