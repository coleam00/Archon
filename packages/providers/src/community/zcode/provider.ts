import { spawn } from 'node:child_process';
import type { CredentialStatus, ProviderFailureClass } from '@archon/provider-contract';
import { buildProviderSubprocessEnv } from '@archon/provider-contract';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { ZCODE_CAPABILITIES } from './capabilities';
import { parseZcodeConfig } from './config';
import { failureResult } from '../../shared/failure';

/** The `--json` epilogue one headless `zcode -p` call prints on success. */
interface ZcodeEpilogue {
  sessionId?: string;
  response?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  projection?: {
    turnCount?: number;
  };
}

/**
 * ZCode community provider: one turn = one headless `zcode -p` child process.
 *
 * The CLI prints a single JSON epilogue when the turn ends (no mid-turn stream), so
 * the provider yields the whole reply as the terminal `result` chunk and nothing
 * before it. Session continuity rides `--resume <sessionId>`; the epilogue's
 * sessionId is reported back so the engine can chain sequential nodes.
 */
export class ZcodeProvider implements IAgentProvider {
  async checkCredential(): Promise<CredentialStatus> {
    // The CLI authenticates through its own desktop login; proving it usable needs a
    // model request, which this check must not make.
    return { state: 'not_checked', source: 'native' };
  }

  /**
   * One call is one attempt; the engine owns retry. A failure ends in a `result`
   * carrying a typed `failure`, then `settled`. Only cancellation throws.
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    try {
      const result = await this.runHeadless(prompt, cwd, resumeSessionId, requestOptions);
      // The CLI prints one epilogue instead of streaming, so the whole reply is
      // delivered as a single message block before the terminal result. The
      // dag-executor counts a turn with no message block as empty output.
      const text = result.type === 'result' ? (result.text ?? '') : '';
      if (text !== '') yield { type: 'agent_message_chunk', text };
      yield result;
    } catch (error) {
      if (requestOptions?.abortSignal?.aborted === true) throw error;
      const err = error as Error;
      yield failureResult(zcodeFailureClass(err), 'zcode_query_failed', err.message);
    }
    yield { type: 'settled' };
  }

  private async runHeadless(
    prompt: string,
    cwd: string,
    resumeSessionId: string | undefined,
    requestOptions: SendQueryOptions | undefined
  ): Promise<MessageChunk> {
    const assistantConfig = parseZcodeConfig(requestOptions?.assistantConfig ?? {});
    const cli = assistantConfig.cliPath ?? 'zcode';

    const args = ['-p', prompt, '--json', '--no-color', '--cwd', cwd];

    const mode = assistantConfig.mode;
    if (mode) args.push('--mode', mode);

    if (resumeSessionId) args.push('--resume', resumeSessionId);

    const denied = [
      ...(assistantConfig.disallowedTools ?? []),
      ...((requestOptions?.nodeConfig?.denied_tools as string[] | undefined) ?? []),
    ].filter(Boolean);
    if (denied.length > 0) args.push('--disallowed-tools', denied.join(','));

    const abortSignal = requestOptions?.abortSignal;
    if (abortSignal?.aborted) throw new Error('ZCode query aborted');

    return await new Promise<MessageChunk>((resolve, reject) => {
      const child = spawn(cli, args, {
        cwd,
        env: buildProviderSubprocessEnv(requestOptions),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('ZCode query aborted'));
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.on('error', err => {
        if (settled) return;
        settled = true;
        abortSignal?.removeEventListener('abort', onAbort);
        reject(new Error(`zcode spawn failed: ${err.message}`));
      });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        abortSignal?.removeEventListener('abort', onAbort);

        if (abortSignal?.aborted) {
          reject(new Error('ZCode query aborted'));
          return;
        }
        if (code !== 0) {
          reject(new Error(zcodeErrorEvidence(code, stderr, stdout)));
          return;
        }
        const epilogue = parseEpilogue(stdout);
        if (!epilogue) {
          reject(new Error(`zcode produced no JSON epilogue (exit ${String(code)})`));
          return;
        }
        resolve(epilogueToResult(epilogue, resumeSessionId));
      });
    });
  }

  getType(): string {
    return 'zcode';
  }

  getCapabilities(): ProviderCapabilities {
    return ZCODE_CAPABILITIES;
  }
}

/**
 * The epilogue is one JSON document the CLI prints when the turn ends. Parse the whole
 * stdout first; if leading noise lines exist, fall back to the first balanced object
 * from the first opening brace (never the last brace — that is a nested object like
 * `projection`, which parses fine and silently drops sessionId/response/usage).
 */
function parseEpilogue(stdout: string): ZcodeEpilogue | undefined {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed) as ZcodeEpilogue;
  } catch {
    // fall through to the balanced scan
  }
  const start = trimmed.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1)) as ZcodeEpilogue;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function epilogueToResult(
  epilogue: ZcodeEpilogue,
  resumeSessionId: string | undefined
): MessageChunk {
  const usage = epilogue.usage;
  const tokens =
    usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
      ? {
          input: usage.inputTokens,
          output: usage.outputTokens,
          ...(typeof usage.totalTokens === 'number' ? { total: usage.totalTokens } : {}),
        }
      : undefined;

  return {
    type: 'result',
    text: epilogue.response ?? '',
    ...(epilogue.sessionId ? { sessionId: epilogue.sessionId } : {}),
    ...(tokens ? { tokens } : { tokensUnknown: true as const }),
    ...(typeof epilogue.projection?.turnCount === 'number'
      ? { numTurns: epilogue.projection.turnCount }
      : {}),
    // A resume that produced a session id restored it; the CLI errors otherwise.
    ...(resumeSessionId !== undefined ? { resumed: epilogue.sessionId === resumeSessionId } : {}),
  };
}

function zcodeErrorEvidence(code: number | null, stderr: string, stdout: string): string {
  const tail = (stderr.trim() || stdout.trim()).split('\n').slice(-3).join(' ');
  return `zcode exited ${String(code)}: ${tail.slice(0, 500)}`;
}

/**
 * Structured classification from the CLI's own error signals only, never prose guessing:
 * balance is quota_exhausted, credentials are auth, 429 is rate limiting, everything
 * else is unknown for the engine to decide.
 */
function zcodeFailureClass(error: Error): ProviderFailureClass {
  const message = error.message;
  if (/insufficient balance/i.test(message)) return 'quota_exhausted';
  if (/invalid[_ ]api[_ ]key|unauthorized|401|403/i.test(message)) return 'auth';
  if (/429|rate limit/i.test(message)) return 'rate_limited';
  return 'unknown';
}
