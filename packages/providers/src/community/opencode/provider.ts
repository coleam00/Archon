import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { OPENCODE_CAPABILITIES } from './capabilities';
import { parseOpencodeConfig } from './config';
import { ensureServer, generatePassword } from './server-manager';
import { bridgeEvents } from './event-bridge';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode');
  return cachedLog;
}

/**
 * OpenCode community provider — wraps `@opencode-ai/sdk` to connect to an
 * OpenCode Server (auto-started on first use or connected to an existing one).
 *
 * OpenCode is a client/server AI coding agent. Each `sendQuery()` call:
 *   1. Ensures the OpenCode Server is running
 *   2. Creates an SDK client
 *   3. Creates or resumes a session
 *   4. Sends the prompt via `session.prompt()`
 *   5. Bridges SSE events to Archon MessageChunks
 *
 * Capabilities: sessionResume, mcp, skills, toolRestrictions, structuredOutput,
 * envInjection, effortControl, thinkingControl.
 */
export class OpenCodeProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    // Lazy-load SDK to avoid runtime deps at module load.
    const { createOpencodeClient } = await import('@opencode-ai/sdk');

    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const config = parseOpencodeConfig(assistantConfig);

    const hostname = config.hostname ?? '127.0.0.1';
    const port = config.port ?? 4096;
    const password =
      config.serverPassword ?? process.env.OPENCODE_SERVER_PASSWORD ?? generatePassword();
    const autoStart = config.autoStartServer !== false;

    // 1. Ensure server is running
    const serverInfo = await ensureServer({ hostname, port, cwd, password }, autoStart);

    // 2. Create SDK client
    const client = createOpencodeClient({
      baseUrl: `http://${serverInfo.hostname}:${serverInfo.port}`,
    });

    // 3. Resolve model
    const modelRef = requestOptions?.model ?? config.model;
    let modelProvider: string | undefined;
    let modelId: string | undefined;
    if (modelRef) {
      const parts = modelRef.split('/');
      if (parts.length >= 2) {
        modelProvider = parts[0];
        modelId = parts.slice(1).join('/');
      }
    }

    // 4. Session management
    let sessionId: string;
    let resumeFailed = false;

    if (resumeSessionId) {
      try {
        // Verify the session exists
        await client.session.get({ path: { id: resumeSessionId } });
        sessionId = resumeSessionId;
        getLog().debug({ sessionId }, 'opencode.session.resumed');
      } catch {
        resumeFailed = true;
        getLog().warn({ sessionId: resumeSessionId }, 'opencode.session.resume_failed');
        const session = await client.session.create({
          body: { title: 'Archon Workflow' },
          query: { directory: cwd },
        });
        sessionId = session.data?.id ?? '';
      }
    } else {
      const session = await client.session.create({
        body: { title: 'Archon Workflow' },
        query: { directory: cwd },
      });
      sessionId = session.data?.id ?? '';
    }

    if (!sessionId) {
      throw new Error('OpenCode: failed to create session');
    }

    if (resumeFailed) {
      yield {
        type: 'system',
        content: '⚠️ Could not resume OpenCode session. Starting fresh conversation.',
      };
    }

    // 5. Translate nodeConfig to SDK options
    const nodeConfig = requestOptions?.nodeConfig;

    // Tool restrictions
    const tools = nodeConfig?.allowed_tools
      ? Object.fromEntries(nodeConfig.allowed_tools.map(t => [t, true]))
      : undefined;

    // System prompt
    const systemPrompt = requestOptions?.systemPrompt ?? nodeConfig?.systemPrompt;

    // Structured output
    const outputFormat = requestOptions?.outputFormat;

    getLog().info(
      {
        model: modelRef,
        cwd,
        hasSystemPrompt: systemPrompt !== undefined,
        hasTools: tools !== undefined,
        hasOutputFormat: outputFormat !== undefined,
        resumed: resumeSessionId !== undefined && !resumeFailed,
      },
      'opencode.session_started'
    );

    // 6. Send prompt
    try {
      // Use promptAsync to start the message, then consume events
      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: prompt }],
          ...(modelProvider && modelId
            ? { model: { providerID: modelProvider, modelID: modelId } }
            : {}),
          ...(systemPrompt ? { system: systemPrompt } : {}),
          ...(tools ? { tools } : {}),
        },
        query: { directory: cwd },
      });

      // 7. Bridge SSE events to MessageChunks
      yield* bridgeEvents(client, sessionId, requestOptions?.abortSignal);

      getLog().info({ sessionId }, 'opencode.prompt_completed');
    } catch (err) {
      getLog().error({ err, sessionId }, 'opencode.prompt_failed');
      throw err;
    }
  }

  getType(): string {
    return 'opencode';
  }

  getCapabilities(): ProviderCapabilities {
    return OPENCODE_CAPABILITIES;
  }
}
