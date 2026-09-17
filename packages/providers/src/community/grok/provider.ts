import { createLogger } from '@archon/paths';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import { withResumedOutcome, resumedOutcome } from '../../shared/resumed';
import { GROK_CAPABILITIES } from './capabilities';
import { DEFAULT_GROK_MODEL, parseGrokConfig, resolveGrokEffort } from './config';
import { resolveGrokBinaryPath } from './binary-resolver';
import { buildGrokEnv } from './env';
import { buildGrokArgv } from './argv';
import { parseGrokOutput } from './stream';
import { runGrokCommand, type GrokCommandRunner } from './transport';

type ResultChunk = Extract<MessageChunk, { type: 'result' }>;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.grok');
  return cachedLog;
}

/**
 * Grok's additive system-prompt channel is `--rules` (appended to the agent
 * prompt). `--system-prompt-override` would replace the coding-agent identity,
 * so we never use it. Claude-only SystemPromptPreset objects are dropped.
 */
function resolveSystemPrompt(options?: SendQueryOptions): string | undefined {
  const raw = options?.systemPrompt ?? options?.nodeConfig?.systemPrompt;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? raw : undefined;
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const text = raw.join('\n\n').trim();
    return text.length > 0 ? raw.join('\n\n') : undefined;
  }
  if (raw !== undefined) {
    getLog().warn({ systemPromptType: typeof raw }, 'grok.system_prompt_dropped_preset');
  }
  return undefined;
}

function createLinePump(): {
  push: (line: string) => void;
  close: () => void;
  iterate: () => AsyncGenerator<string>;
} {
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  let finished = false;
  const kick = (): void => {
    while (waiters.length > 0) waiters.shift()?.();
  };
  return {
    push(line: string): void {
      lines.push(line);
      kick();
    },
    close(): void {
      finished = true;
      kick();
    },
    async *iterate(): AsyncGenerator<string> {
      for (;;) {
        if (lines.length > 0) {
          const line = lines.shift();
          if (line !== undefined) yield line;
          continue;
        }
        if (finished) return;
        await new Promise<void>(resolve => {
          waiters.push(resolve);
          if (lines.length > 0 || finished) kick();
        });
      }
    },
  };
}

export class GrokProvider implements IAgentProvider {
  constructor(private readonly runner: GrokCommandRunner = runGrokCommand) {}

  getType(): string {
    return 'grok';
  }

  getCapabilities(): ProviderCapabilities {
    return GROK_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const config = parseGrokConfig(options?.assistantConfig ?? {});
    const model = options?.model?.trim() || config.model?.trim() || DEFAULT_GROK_MODEL;
    const effort = resolveGrokEffort(options?.nodeConfig?.effort, config.modelReasoningEffort);
    const command = resolveGrokBinaryPath(config.grokBinaryPath);
    const env = buildGrokEnv(options?.env);
    const jsonSchema =
      options?.outputFormat?.type === 'json_schema'
        ? options.outputFormat.schema
        : options?.nodeConfig?.output_format;
    const systemPrompt = resolveSystemPrompt(options);
    const argv = buildGrokArgv({
      command,
      prompt,
      cwd,
      model,
      ...(effort ? { effort } : {}),
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(jsonSchema ? { jsonSchema } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
    });

    const abort = new AbortController();
    const signal = options?.abortSignal
      ? AbortSignal.any([options.abortSignal, abort.signal])
      : abort.signal;

    const pump = createLinePump();
    const running = this.runner({
      argv,
      cwd,
      env,
      signal,
      onLine: line => {
        pump.push(line);
      },
    }).finally(() => {
      pump.close();
    });

    const bufferedResults: MessageChunk[] = [];
    try {
      for await (const line of pump.iterate()) {
        let chunks: MessageChunk[];
        try {
          chunks = parseGrokOutput(line);
        } catch (error) {
          abort.abort();
          bufferedResults.push({
            type: 'result',
            isError: true,
            errorSubtype: 'grok_stream_json_invalid',
            errors: [error instanceof Error ? error.message : 'grok_stream_json_invalid'],
          });
          break;
        }
        for (const chunk of chunks) {
          if (chunk.type === 'result') bufferedResults.push(chunk);
          else yield chunk;
        }
      }
    } finally {
      abort.abort();
    }

    const result = await running.catch((error: unknown) => ({
      exitCode: 1,
      stderr: error instanceof Error ? error.message : String(error),
      nativeClosed: false,
    }));

    const terminal = terminalResult(bufferedResults, result.exitCode, result.stderr);
    yield* withResumedOutcome(
      (async function* (): AsyncGenerator<MessageChunk> {
        yield terminal;
      })(),
      resumedOutcome(resumeSessionId, Boolean(resumeSessionId) && terminal.isError !== true)
    );
  }
}

function terminalResult(buffered: MessageChunk[], exitCode: number, stderr: string): ResultChunk {
  const last = [...buffered].reverse().find(chunk => chunk.type === 'result');
  if (last?.type === 'result') {
    if (exitCode !== 0 && last.isError !== true) {
      return {
        ...last,
        isError: true,
        errorSubtype: last.errorSubtype ?? 'grok_exit',
        errors: last.errors ?? [stderr.trim() || `grok_exit_${exitCode}`],
      };
    }
    return last;
  }
  return {
    type: 'result',
    isError: true,
    errorSubtype: 'grok_stream_incomplete',
    errors: [
      stderr.trim() || (exitCode !== 0 ? `grok_exit_${exitCode}` : 'grok_stream_incomplete'),
    ],
  };
}
