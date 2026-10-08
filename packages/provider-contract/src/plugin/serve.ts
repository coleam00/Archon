import { providerDiagnosticsSchema, providerModelListSchema } from '../information';
import { Readable, Writable } from 'node:stream';
import type { IAgentProvider } from '../agent-provider';
import type { ProviderStopReason } from '../result';
import { PluginRemoteError, PluginRpc, type PluginIO } from './rpc';
import {
  diagnoseRequestSchema,
  listModelsRequestSchema,
  acpStopReason,
  toolCallResponseSchema,
  logNotificationSchema,
  type ProviderLogSink,
  cancelNotificationSchema,
  checkCredentialRequestSchema,
  initializeRequestSchema,
  newSessionRequestSchema,
  promptRequestSchema,
  providerPluginDescriptorSchema,
  resolveCredentialModelRequestSchema,
  type ProviderPluginDescriptor,
  type ProviderSessionRequest,
} from './wire';

export async function serveProvider(
  options: {
    descriptor: ProviderPluginDescriptor;
    create: (log: ProviderLogSink) => IAgentProvider;
  },
  io: PluginIO = {
    readable: Readable.toWeb(process.stdin),
    writable: Writable.toWeb(process.stdout),
  }
): Promise<void> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const descriptor = providerPluginDescriptorSchema.parse(options.descriptor);
  const rpc = new PluginRpc(io);
  rpc.plugin = descriptor.id;
  const log: ProviderLogSink = record =>
    rpc.notify('_archon/log', logNotificationSchema.parse(record));
  const connectionAbort = new AbortController();
  const sessions = new Map<
    string,
    { request: ProviderSessionRequest; abort: AbortController; active: boolean }
  >();
  let initialized = false;
  let nextSession = 0;
  function requireInitialized(): void {
    if (!initialized) throw new Error('initialize must complete before provider requests');
  }
  rpc.handle('initialize', raw => {
    initializeRequestSchema.parse(raw);
    initialized = true;
    return {
      protocolVersion: 1,
      agentCapabilities: { _meta: { archon: descriptor } },
      authMethods: [],
    };
  });
  rpc.handle('session/new', raw => {
    requireInitialized();
    const params = newSessionRequestSchema.parse(raw);
    const request = params._meta.archon.request;
    if (request.cwd !== params.cwd)
      throw new Error('session/new cwd disagrees with Archon request');
    const sessionId = String(nextSession++);
    sessions.set(sessionId, { request, abort: new AbortController(), active: false });
    return { sessionId };
  });
  rpc.handle('session/prompt', async raw => {
    requireInitialized();
    const params = promptRequestSchema.parse(raw);
    const session = sessions.get(params.sessionId);
    if (!session || session.active) throw new Error('Unknown or active provider session');
    const { prompt, cwd, resumeSessionId, nativeTools, ...requestOptions } = session.request;
    if (params.prompt[0].text !== prompt)
      throw new Error('session/prompt disagrees with Archon request');
    session.active = true;
    let reason: ProviderStopReason | undefined;
    try {
      for await (const chunk of options.create(log).sendQuery(prompt, cwd, resumeSessionId, {
        ...requestOptions,
        env: requestOptions.execContext?.kind === 'container' ? requestOptions.env : env,
        ...(nativeTools
          ? {
              nativeTools: nativeTools.map(spec => ({
                ...spec,
                handler: async (input): Promise<string> =>
                  rpc.parse(
                    toolCallResponseSchema,
                    await rpc.request('_archon/tool_call', {
                      sessionId: params.sessionId,
                      name: spec.name,
                      input,
                    })
                  ).text,
              })),
            }
          : {}),
        abortSignal: session.abort.signal,
      })) {
        if (chunk.type === 'result') reason = chunk.stopReason;
        await rpc.notify('_archon/chunk', { sessionId: params.sessionId, chunk });
      }
      return { stopReason: acpStopReason(reason, session.abort.signal.aborted) };
    } finally {
      sessions.delete(params.sessionId);
    }
  });
  rpc.on('session/cancel', raw => {
    const { sessionId } = rpc.parse(cancelNotificationSchema, raw);
    const session = sessions.get(sessionId);
    session?.abort.abort();
    if (session && !session.active) sessions.delete(sessionId);
  });
  rpc.handle('_archon/check_credential', async raw => {
    requireInitialized();
    const request = checkCredentialRequestSchema.parse(raw);
    return options.create(log).checkCredential({ ...request, env, signal: connectionAbort.signal });
  });
  rpc.handle('_archon/resolve_credential_model', async raw => {
    requireInitialized();
    const request = resolveCredentialModelRequestSchema.parse(raw);
    const model = await options.create(log).resolveCredentialModel?.(request);
    return model === undefined ? {} : { model };
  });
  rpc.handle('_archon/diagnose', async raw => {
    requireInitialized();
    const request = diagnoseRequestSchema.parse(raw);
    const provider = options.create(log);
    if (!provider.diagnose)
      throw new PluginRemoteError(-32601, 'Provider does not support diagnose');
    return providerDiagnosticsSchema.parse(await provider.diagnose(request));
  });
  rpc.handle('_archon/list_models', async raw => {
    requireInitialized();
    listModelsRequestSchema.parse(raw);
    const provider = options.create(log);
    if (!provider.listModels)
      throw new PluginRemoteError(-32601, 'Provider does not support listModels');
    return providerModelListSchema.parse(
      await provider.listModels({ signal: new AbortController().signal })
    );
  });
  try {
    await rpc.done;
  } finally {
    connectionAbort.abort();
    for (const session of sessions.values()) session.abort.abort();
    await rpc.drain();
    await rpc.close();
  }
}
