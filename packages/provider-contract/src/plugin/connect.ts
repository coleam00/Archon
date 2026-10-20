import { z } from 'zod';
import { nativeToolInputParser } from '../native-tools';
import {
  providerDiagnosticsSchema,
  providerModelListSchema,
  type ProviderDiagnostics,
  type ProviderModelList,
} from '../information';
import type { IAgentProvider, SendQueryOptions } from '../agent-provider';
import { credentialStatusSchema, type CredentialStatus } from '../credential-status';
import type { ProviderChunk } from '../events';
import type { ProviderSettled } from '../settled';
import { PluginProtocolError, PluginRpc, type PluginIO } from './rpc';
import {
  PROVIDER_PLUGIN_PROTOCOL,
  diagnoseRequestSchema,
  listModelsRequestSchema,
  chunkNotificationSchema,
  toolCallRequestSchema,
  logNotificationSchema,
  type ProviderLog,
  checkCredentialParamsSchema,
  resolveCredentialModelRequestSchema,
  HOST_ONLY_REQUEST_KEYS,
  initializeResponseSchema,
  newSessionResponseSchema,
  promptResponseSchema,
  providerSessionRequestSchema,
  resolveCredentialModelResponseSchema,
  providerPluginDescriptorSchema,
  type ProviderPluginDescriptor,
} from './wire';

export interface ConnectedProvider extends IAgentProvider {
  readonly descriptor: ProviderPluginDescriptor;
  resolveCredentialModel(
    request: Parameters<NonNullable<IAgentProvider['resolveCredentialModel']>>[0]
  ): Promise<string | undefined>;
  diagnose: NonNullable<IAgentProvider['diagnose']>;
  listModels: NonNullable<IAgentProvider['listModels']>;
  close(): Promise<void>;
}

interface Turn {
  controller: ReadableStreamDefaultController<ProviderChunk>;
  tools: NonNullable<SendQueryOptions['nativeTools']>;
  settled: ProviderSettled | undefined;
  ended: boolean;
  cancelled: boolean;
}
function finish(turn: Turn, error?: unknown): void {
  if (turn.ended) return;
  turn.ended = true;
  if (error !== undefined) turn.controller.error(error);
  else turn.controller.close();
}

function omitUndefinedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefinedFields);
  if (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, field]) => field !== undefined)
        .map(([key, field]) => [key, omitUndefinedFields(field)])
    );
  }
  return value;
}

// Reads only what a plugin on any protocol advertises, so a mismatch names both versions
// instead of failing the full descriptor parse.
const advertisedProtocolSchema = z.object({
  agentCapabilities: z.object({
    _meta: z.object({
      archon: providerPluginDescriptorSchema
        .pick({ id: true })
        .extend({ protocol: z.number().int().positive() }),
    }),
  }),
});

export async function connectProvider(
  io: PluginIO,
  options: { onLog?: (record: ProviderLog) => void } = {}
): Promise<ConnectedProvider> {
  const rpc = new PluginRpc(io);
  const turns = new Map<string, Turn>();
  rpc.handle('_archon/tool_call', async raw => {
    const { sessionId, name, input } = rpc.parse(toolCallRequestSchema, raw);
    const turn = turns.get(sessionId);
    if (!turn || turn.ended || turn.cancelled || turn.settled)
      throw rpc.error('tool call names an inactive session');
    const tool = turn.tools.find(tool => tool.name === name);
    if (!tool) throw rpc.error('tool call names an unknown tool');
    const parsed = nativeToolInputParser(tool.inputSchema).safeParse(input);
    if (!parsed.success) throw rpc.error('invalid tool input');
    return { text: await tool.handler(parsed.data) };
  });
  rpc.on('_archon/log', raw => {
    const record = rpc.parse(logNotificationSchema, raw);
    options.onLog?.(record);
  });
  rpc.on('_archon/chunk', raw => {
    const { sessionId, chunk } = rpc.parse(chunkNotificationSchema, raw);
    const turn = turns.get(sessionId);
    if (!turn) throw rpc.error('chunk names an unknown session');
    if (turn.settled) throw rpc.error('chunk arrived after settled');
    // A provider can reject while unwinding after settled. Do not expose completion
    // until session/prompt acknowledges that the provider's iterator succeeded.
    if (chunk.type === 'settled') {
      turn.settled = chunk;
      return;
    }
    if (turn.ended) return;
    turn.controller.enqueue(chunk);
  });
  let descriptor: ProviderPluginDescriptor;
  try {
    const raw = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { archon: { protocol: PROVIDER_PLUGIN_PROTOCOL } },
      },
    });
    const advertised = advertisedProtocolSchema.safeParse(raw);
    if (advertised.success) {
      const { id, protocol } = advertised.data.agentCapabilities._meta.archon;
      if (protocol !== PROVIDER_PLUGIN_PROTOCOL) {
        rpc.plugin = id;
        throw rpc.mismatch(PROVIDER_PLUGIN_PROTOCOL, protocol);
      }
    }
    const response = rpc.parse(initializeResponseSchema, raw);
    descriptor = response.agentCapabilities._meta.archon;
    rpc.plugin = descriptor.id;
  } catch (error) {
    await rpc.close();
    throw error;
  }

  return {
    descriptor,
    getType: () => descriptor.id,
    getCapabilities: () => descriptor.capabilities,
    close: () => rpc.close(),
    async diagnose(request): Promise<ProviderDiagnostics> {
      request.signal.throwIfAborted();
      return rpc.parse(
        providerDiagnosticsSchema,
        await abortable(
          rpc.request(
            '_archon/diagnose',
            diagnoseRequestSchema.parse({
              assistantConfig: omitUndefinedFields(request.assistantConfig),
            })
          ),
          request.signal
        )
      );
    },
    async listModels(request): Promise<ProviderModelList> {
      request.signal.throwIfAborted();
      return rpc.parse(
        providerModelListSchema,
        await abortable(
          rpc.request('_archon/list_models', listModelsRequestSchema.parse({})),
          request.signal
        )
      );
    },
    async checkCredential(request): Promise<CredentialStatus> {
      request.signal.throwIfAborted();
      const { env, signal, ...params } = request;
      const response = rpc.request(
        '_archon/check_credential',
        checkCredentialParamsSchema.parse({
          ...params,
          ...(request.execContext?.kind === 'container' ? { env } : {}),
        })
      );
      return rpc.parse(credentialStatusSchema, await abortable(response, signal));
    },
    async resolveCredentialModel(request): Promise<string | undefined> {
      return rpc.parse(
        resolveCredentialModelResponseSchema,
        await rpc.request(
          '_archon/resolve_credential_model',
          resolveCredentialModelRequestSchema.parse(request)
        )
      ).model;
    },
    async *sendQuery(
      prompt: string,
      cwd: string,
      resumeSessionId?: string,
      options: SendQueryOptions = {}
    ): AsyncGenerator<ProviderChunk> {
      if (options.abortSignal?.aborted) return;
      const serializable = Object.fromEntries(
        Object.entries(options)
          .filter(
            ([key]) =>
              key !== 'nativeTools' &&
              key !== 'env' &&
              !HOST_ONLY_REQUEST_KEYS.some(hostKey => hostKey === key)
          )
          .map(([key, value]) => [
            key,
            key === 'nodeConfig' || key === 'assistantConfig' ? omitUndefinedFields(value) : value,
          ])
      );
      const request = providerSessionRequestSchema.parse({
        ...serializable,
        ...(options.nativeTools
          ? { nativeTools: options.nativeTools.map(({ handler: _handler, ...spec }) => spec) }
          : {}),
        ...(options.execContext?.kind === 'container' && options.env ? { env: options.env } : {}),
        prompt,
        cwd,
        resumeSessionId,
      });
      const { sessionId } = rpc.parse(
        newSessionResponseSchema,
        await rpc.request('session/new', {
          cwd,
          mcpServers: [],
          _meta: { archon: { request } },
        })
      );
      if (options.abortSignal?.aborted) {
        await rpc.notify('session/cancel', { sessionId });
        return;
      }
      let turn!: Turn;
      const chunks = new ReadableStream<ProviderChunk>({
        start(controller): void {
          turn = {
            controller,
            tools: options.nativeTools ?? [],
            settled: undefined,
            ended: false,
            cancelled: false,
          };
          turns.set(sessionId, turn);
        },
      });
      const reader = chunks.getReader();
      const cancel = (): void => {
        if (turn.cancelled || turn.settled) return;
        turn.cancelled = true;
        void rpc.notify('session/cancel', { sessionId }).catch(error => {
          finish(turn, error);
        });
      };
      options.abortSignal?.addEventListener('abort', cancel, { once: true });
      const prompted = rpc.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
      void prompted
        .then(raw => {
          rpc.parse(promptResponseSchema, raw);
          if (!turn.settled && !turn.cancelled)
            throw rpc.error('provider stream ended before settled');
          if (turn.settled && !turn.ended) turn.controller.enqueue(turn.settled);
          finish(turn);
        })
        .catch(error => {
          if (turn.cancelled && error instanceof PluginProtocolError && error.reason === 'closed')
            finish(turn);
          else finish(turn, error);
        })
        .finally(() => {
          turns.delete(sessionId);
        });
      if (options.abortSignal?.aborted) cancel();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
          if (value.type === 'settled') return;
        }
      } finally {
        options.abortSignal?.removeEventListener('abort', cancel);
        cancel();
        turn.ended = true;
        await reader.cancel();
        reader.releaseLock();
      }
    },
  };
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = (): void => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}
