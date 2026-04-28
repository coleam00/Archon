// IMPORTANT: Do NOT add static `import { createOpencode } from '@opencode-ai/sdk'` here.
// The SDK calls `cross-spawn('opencode', ...)` at server start; inside a compiled
// Archon binary that binary lookup may fail at startup if opencode isn't on PATH.
// The dynamic import below defers the spawn to the first actual sendQuery call so
// the process doesn't crash at boot when opencode is absent but unused.
// Type-only imports are fine — TypeScript erases them.

import type { OpencodeClient } from '@opencode-ai/sdk';

import { sep } from 'node:path';

import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import { OPENCODE_CAPABILITIES } from './capabilities';
import { parseOpencodeConfig, parseOpencodeModel } from './config';
import { augmentPromptForJsonSchema, bridgeOpencodeEvents } from './event-bridge';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode');
  return cachedLog;
}

/**
 * Module-level singleton for the opencode server process.
 *
 * One server process services all OpencodeProvider instances for the
 * lifetime of the parent process. Lazily initialized on first sendQuery,
 * which lets the module be imported without spawning a child process.
 * On error the promise is cleared so the next call retries.
 */
let serverState:
  | Promise<{ client: OpencodeClient; server: { url: string; close(): void } }>
  | undefined;

function getOrCreateServer(
  opencodeBinaryDir?: string
): Promise<{ client: OpencodeClient; server: { url: string; close(): void } }> {
  if (!serverState) {
    serverState = (async (): Promise<{
      client: OpencodeClient;
      server: { url: string; close(): void };
    }> => {
      // Prepend the user-configured binary directory to PATH so cross-spawn
      // finds `opencode` even when it's installed outside the default PATH.
      if (opencodeBinaryDir) {
        const pathSep = sep === '\\' ? ';' : ':';
        if (!process.env.PATH?.includes(opencodeBinaryDir)) {
          process.env.PATH = `${opencodeBinaryDir}${pathSep}${process.env.PATH ?? ''}`;
          getLog().debug({ opencodeBinaryDir }, 'opencode.path_prepended');
        }
      }

      const { createOpencode } = await import('@opencode-ai/sdk');
      const result = await createOpencode();

      getLog().info({ url: result.server.url }, 'opencode.server_started');

      // Best-effort cleanup on process exit.
      process.on('exit', () => {
        result.server.close();
      });

      return result;
    })().catch((err: unknown) => {
      // Clear so the next sendQuery can retry (e.g. after installing opencode).
      serverState = undefined;
      throw err;
    });
  }
  return serverState;
}

/**
 * Opencode community provider — wraps the opencode SDK to give Archon workflows
 * access to any model configured in `~/.config/opencode/opencode.json`, including
 * local Ollama models and any provider opencode supports.
 *
 * Model format: '<providerID>/<modelID>' (e.g. 'ollama/qwen3:8b',
 * 'anthropic/claude-sonnet-4-5', 'openai/gpt-4o').
 * When omitted, opencode uses its configured default model.
 *
 * Each sendQuery call creates a new session (or resumes an existing one when
 * resumeSessionId is provided) and streams events until session.idle or
 * session.error.
 */
export class OpencodeProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = options?.assistantConfig ?? {};
    const config = parseOpencodeConfig(assistantConfig);

    // 1. Ensure the opencode server is running.
    const { client } = await getOrCreateServer(config.opencodeBinaryDir);

    // 2. Resolve model. Request-level wins over config default; when neither
    //    is set we omit the model field so opencode uses its configured default.
    const modelStr = options?.model ?? config.model;
    const modelSpec = modelStr ? parseOpencodeModel(modelStr) : undefined;
    if (modelStr && !modelSpec) {
      yield {
        type: 'system',
        content: `⚠️ opencode: invalid model format '${modelStr}'. Expected '<providerID>/<modelID>' (e.g. 'ollama/qwen3:8b'). Falling back to opencode default.`,
      };
    }

    // 3. Subscribe and start an eager pump so no events are missed.
    //
    //    The SDK returns a lazy async generator that only opens the HTTP
    //    connection on first next(). We start an IIFE pump immediately to
    //    keep the stream alive (Bun closes idle response bodies after ~99ms)
    //    and buffer all events into a single-producer/single-consumer queue
    //    (same pattern as the Pi event bridge). bridgeOpencodeEvents drains
    //    the queue at its own pace without dropping events.
    // Subscribe without a directory filter so the pump receives events from all
    // server instances. The opencode server dispatches model-response events
    // through the process-CWD instance (not the session's cwd instance), so
    // a directory-scoped subscription misses them. bridgeOpencodeEvents already
    // filters by sessionId, so no spurious events reach the caller.
    const { stream } = await client.event.subscribe({});

    // Single-producer/single-consumer async queue.
    const queueBuf: unknown[] = [];
    const queueWaiters: ((r: IteratorResult<unknown>) => void)[] = [];
    let queueClosed = false;

    function queuePush(item: unknown): void {
      const w = queueWaiters.shift();
      if (w) w({ value: item, done: false });
      else queueBuf.push(item);
    }

    function queueClose(): void {
      if (queueClosed) return;
      queueClosed = true;
      while (queueWaiters.length > 0) {
        const w = queueWaiters.shift();
        if (w) w({ value: undefined, done: true });
      }
    }

    async function* queueIterator(): AsyncGenerator {
      while (true) {
        const next = queueBuf.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (queueClosed) return;
        const r = await new Promise<IteratorResult<unknown>>(res => {
          queueWaiters.push(res);
        });
        if (r.done) return;
        yield r.value;
      }
    }

    // Resolves once the SSE connection is confirmed open (first event arrives).
    let resolveFirstEvent: (() => void) | undefined;
    const firstEventPromise = new Promise<void>(res => {
      resolveFirstEvent = res;
    });

    let pumpErr: unknown = null;
    const pumpTask = (async (): Promise<void> => {
      try {
        for await (const ev of stream) {
          if (resolveFirstEvent) {
            resolveFirstEvent();
            resolveFirstEvent = undefined;
          }
          queuePush(ev);
        }
      } catch (err) {
        pumpErr = err;
      } finally {
        if (resolveFirstEvent) {
          resolveFirstEvent();
          resolveFirstEvent = undefined;
        }
        queueClose();
      }
    })();

    // Wait for the SSE connection to open (server.connected arrives first).
    await firstEventPromise;

    // 4. Session management: resume or create.
    let sessionId: string;
    if (resumeSessionId) {
      try {
        const res = await client.session.get({ path: { id: resumeSessionId } });
        sessionId = (res as { data: { id: string } }).data.id;
        getLog().debug({ sessionId }, 'opencode.session_resumed');
      } catch {
        yield {
          type: 'system',
          content: '⚠️ Could not resume opencode session. Starting fresh conversation.',
        };
        const createRes = await client.session.create({ query: { directory: cwd } });
        sessionId = (createRes as { data: { id: string } }).data.id;
      }
    } else {
      const createRes = await client.session.create({ query: { directory: cwd } });
      sessionId = (createRes as { data: { id: string } }).data.id;
    }

    // 5. Structured output: prompt-engineer JSON schema when requested.
    const outputFormat = options?.outputFormat;
    const effectivePrompt = outputFormat
      ? augmentPromptForJsonSchema(prompt, outputFormat.schema)
      : prompt;

    // 6. Fire prompt (fire-and-forget 204 endpoint).
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: effectivePrompt }],
        ...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
        ...(modelSpec ? { model: modelSpec } : {}),
      },
    });

    // 7. Wire abort before entering the stream loop.
    if (options?.abortSignal) {
      options.abortSignal.addEventListener(
        'abort',
        () => {
          void client.session.abort({ path: { id: sessionId } }).catch(() => {
            // Ignore — the stream will terminate via session.idle / session.error.
          });
        },
        { once: true }
      );
    }

    getLog().info(
      {
        sessionId,
        cwd,
        model: modelStr ?? '(opencode default)',
        resumed: resumeSessionId !== undefined,
      },
      'opencode.prompt_started'
    );

    // 8. Bridge events from the live queue → MessageChunk stream.
    try {
      yield* bridgeOpencodeEvents(queueIterator(), sessionId, outputFormat?.schema);
    } catch (err) {
      getLog().error({ err, sessionId }, 'opencode.prompt_failed');
      throw err;
    }
    getLog().info({ sessionId }, 'opencode.prompt_completed');
    await pumpTask;
    if (pumpErr) throw pumpErr as Error;
  }

  getType(): string {
    return 'opencode';
  }

  getCapabilities(): ProviderCapabilities {
    return OPENCODE_CAPABILITIES;
  }
}
