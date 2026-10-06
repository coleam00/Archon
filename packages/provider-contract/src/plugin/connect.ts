import type { IAgentProvider, SendQueryOptions } from '../agent-provider';
import { credentialStatusSchema, type CredentialStatus } from '../credential-status';
import type { ProviderChunk } from '../events';
import type { ProviderSettled } from '../settled';
import { ProviderPluginProtocolError, ProviderRpc, type ProviderPluginIO } from './rpc';
import {
  chunkNotificationSchema,
  checkCredentialRequestSchema,
  resolveCredentialModelRequestSchema,
  HOST_ONLY_REQUEST_KEYS,
  initializeResponseSchema,
  newSessionResponseSchema,
  promptResponseSchema,
  providerSessionRequestSchema,
  resolveCredentialModelResponseSchema,
  type ProviderPluginDescriptor,
} from './wire';

export interface ConnectedProvider extends IAgentProvider {
  readonly descriptor: ProviderPluginDescriptor;
  resolveCredentialModel(
    request: Parameters<NonNullable<IAgentProvider['resolveCredentialModel']>>[0]
  ): Promise<string | undefined>;
  close(): Promise<void>;
}

interface Turn {
  controller: ReadableStreamDefaultController<ProviderChunk>;
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

export async function connectProvider(io: ProviderPluginIO): Promise<ConnectedProvider> {
  const rpc = new ProviderRpc(io);
  const turns = new Map<string, Turn>();
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
    const response = rpc.parse(
      initializeResponseSchema,
      await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: { archon: { protocol: 1 } },
        },
      })
    );
    descriptor = response.agentCapabilities._meta.archon;
    rpc.provider = descriptor.id;
  } catch (error) {
    await rpc.close();
    throw error;
  }

  return {
    descriptor,
    getType: () => descriptor.id,
    getCapabilities: () => descriptor.capabilities,
    close: () => rpc.close(),
    async checkCredential(request): Promise<CredentialStatus> {
      request.signal.throwIfAborted();
      // The connection is shared with running turns, so an abort fails only this call.
      // A late reply settles the pending request and is dropped.
      let abort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        abort = (): void => {
          const reason: unknown = request.signal.reason;
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        };
        request.signal.addEventListener('abort', abort, { once: true });
      });
      try {
        const response = rpc.request(
          '_archon/check_credential',
          checkCredentialRequestSchema.parse({
            model: request.model,
            assistantConfig: request.assistantConfig,
          })
        );
        return rpc.parse(credentialStatusSchema, await Promise.race([response, aborted]));
      } finally {
        if (abort) request.signal.removeEventListener('abort', abort);
      }
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
      if (options.nativeTools?.length)
        throw rpc.error('nativeTools handlers cannot cross the provider wire');
      if (options.abortSignal?.aborted) return;
      const serializable = Object.fromEntries(
        Object.entries(options).filter(
          ([key]) => !HOST_ONLY_REQUEST_KEYS.some(hostKey => hostKey === key)
        )
      );
      const request = providerSessionRequestSchema.parse({
        ...serializable,
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
          if (
            turn.cancelled &&
            error instanceof ProviderPluginProtocolError &&
            error.reason === 'closed'
          )
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
