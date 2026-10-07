import { Readable, Writable } from 'node:stream';
import type { IAgentProvider } from '../agent-provider';
import type { ProviderStopReason } from '../result';
import { PluginRpc, type PluginIO } from './rpc';
import {
  acpStopReason,
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
  options: { descriptor: ProviderPluginDescriptor; create: () => IAgentProvider },
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
    const { prompt, cwd, resumeSessionId, ...requestOptions } = session.request;
    if (params.prompt[0].text !== prompt)
      throw new Error('session/prompt disagrees with Archon request');
    session.active = true;
    let reason: ProviderStopReason | undefined;
    try {
      for await (const chunk of options.create().sendQuery(prompt, cwd, resumeSessionId, {
        ...requestOptions,
        env,
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
    return options.create().checkCredential({ ...request, env, signal: connectionAbort.signal });
  });
  rpc.handle('_archon/resolve_credential_model', async raw => {
    requireInitialized();
    const request = resolveCredentialModelRequestSchema.parse(raw);
    const model = await options.create().resolveCredentialModel?.(request);
    return model === undefined ? {} : { model };
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
