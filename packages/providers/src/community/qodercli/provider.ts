import { randomUUID } from 'node:crypto';
import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
  SystemPromptInput,
} from '../../types';
import { loadMcpConfig } from '../../mcp/config';
import {
  augmentPromptForJsonSchema,
  tryParseStructuredOutput,
} from '../../shared/structured-output';
import { QODERCLI_CAPABILITIES } from './capabilities';
import { parseQoderCliConfig, type QoderCliProviderDefaults } from './config';
import { resolveQoderCliBinaryPath } from './binary-resolver';

const DEFAULT_PERMISSION_MODE: NonNullable<QoderCliProviderDefaults['permissionMode']> =
  'bypass_permissions';
const QODER_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'max']);
const STATUS_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_CHARS = 1_000_000;
const TERMINATION_GRACE_MS = 5_000;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.qodercli');
  return cachedLog;
}

export interface QoderCliProcess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals) => void;
}

export interface QoderCliSpawnOptions {
  cwd: string;
  env: Record<string, string>;
}

export type QoderCliSpawner = (command: string[], options: QoderCliSpawnOptions) => QoderCliProcess;

interface ProviderWarning {
  message: string;
}

interface BuildQoderCliArgsInput {
  prompt: string;
  cwd: string;
  config: QoderCliProviderDefaults;
  requestOptions?: SendQueryOptions;
  resumeSessionId?: string;
  mcpConfigJson?: string;
}

interface BuildQoderCliArgsResult {
  args: string[];
  sessionId: string;
  warnings: ProviderWarning[];
}

function defaultSpawner(command: string[], options: QoderCliSpawnOptions): QoderCliProcess {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: (signal?: NodeJS.Signals): void => {
      proc.kill(signal);
    },
  };
}

function buildProviderEnv(requestEnv?: Record<string, string>): Record<string, string> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return { ...baseEnv, ...(requestEnv ?? {}) };
}

function appendCapturedOutput(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURE_CHARS) return current;
  const remaining = MAX_CAPTURE_CHARS - current.length;
  return current + chunk.slice(0, remaining);
}

function scheduleKill(proc: QoderCliProcess): ReturnType<typeof setTimeout> {
  proc.kill('SIGTERM');
  const timer = setTimeout(() => {
    proc.kill('SIGKILL');
  }, TERMINATION_GRACE_MS);
  if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

function buildSpawnCommand(binaryPath: string, args: string[]): string[] {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(binaryPath)) {
    return ['cmd.exe', '/d', '/s', '/c', binaryPath, ...args];
  }
  return [binaryPath, ...args];
}

function buildMcpEnvSource(
  requestEnv?: Record<string, string>
): Record<string, string | undefined> {
  return requestEnv ? { ...process.env, ...requestEnv } : process.env;
}

function resolveSystemPrompt(
  input: SystemPromptInput | undefined
): { flag: '--system-prompt' | '--append-system-prompt'; value: string } | undefined {
  if (typeof input === 'string') {
    return input.length > 0 ? { flag: '--system-prompt', value: input } : undefined;
  }
  if (Array.isArray(input)) {
    const value = input.filter(part => part.length > 0).join('\n\n');
    return value.length > 0 ? { flag: '--system-prompt', value } : undefined;
  }
  if (input?.type === 'preset' && typeof input.append === 'string' && input.append.length > 0) {
    return { flag: '--append-system-prompt', value: input.append };
  }
  return undefined;
}

function normalizeReasoning(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return QODER_REASONING_EFFORTS.has(value) ? value : undefined;
}

function resolveReasoning(
  requestOptions: SendQueryOptions | undefined,
  config: QoderCliProviderDefaults,
  warnings: ProviderWarning[]
): string | undefined {
  const nodeConfig = requestOptions?.nodeConfig;
  const rawThinking = nodeConfig?.thinking;
  const rawEffort = nodeConfig?.effort;

  if (rawThinking === 'off' || rawEffort === 'off') return undefined;

  const thinkingEffort = normalizeReasoning(rawThinking);
  if (thinkingEffort) return thinkingEffort;

  const nodeEffort = normalizeReasoning(rawEffort);
  if (nodeEffort) return nodeEffort;

  if (rawThinking !== undefined && rawThinking !== null && typeof rawThinking === 'object') {
    warnings.push({
      message:
        'Qoder CLI ignored `thinking` object config. Use `effort: low|medium|high|max` instead.',
    });
    return config.modelReasoningEffort;
  }

  if (typeof rawThinking === 'string' || typeof rawEffort === 'string') {
    const ignored = typeof rawThinking === 'string' ? rawThinking : rawEffort;
    warnings.push({
      message: `Qoder CLI ignored unknown reasoning level '${ignored}'. Valid: low, medium, high, max, off.`,
    });
  }

  return config.modelReasoningEffort;
}

function appendRepeatedFlag(args: string[], flag: string, values: string[] | undefined): void {
  if (!values || values.length === 0) return;
  for (const value of values) {
    args.push(flag, value);
  }
}

export function buildQoderCliArgs(input: BuildQoderCliArgsInput): BuildQoderCliArgsResult {
  const warnings: ProviderWarning[] = [];
  const args: string[] = ['--print', '--cwd', input.cwd];
  const sessionId =
    input.requestOptions?.forkSession === true || !input.resumeSessionId
      ? randomUUID()
      : input.resumeSessionId;

  if (input.config.configDir) {
    args.push('--config-dir', input.config.configDir);
  }

  const model = input.requestOptions?.model ?? input.config.model;
  if (model) {
    args.push('--model', model);
  }

  const reasoning = resolveReasoning(input.requestOptions, input.config, warnings);
  if (reasoning) {
    args.push('--reasoning-effort', reasoning);
  }

  args.push('--permission-mode', input.config.permissionMode ?? DEFAULT_PERMISSION_MODE);

  if (!input.requestOptions?.outputFormat && input.config.outputFormat) {
    args.push('--output-format', input.config.outputFormat);
  }

  if (input.config.settingSources && input.config.settingSources.length > 0) {
    args.push('--setting-sources', input.config.settingSources.join(','));
  }

  const systemPrompt = resolveSystemPrompt(
    input.requestOptions?.systemPrompt ?? input.requestOptions?.nodeConfig?.systemPrompt
  );
  if (systemPrompt) {
    args.push(systemPrompt.flag, systemPrompt.value);
  }

  const mcpConfig = input.mcpConfigJson ?? input.config.mcpConfig;
  if (mcpConfig) {
    args.push('--mcp-config', mcpConfig);
    if (input.mcpConfigJson) {
      args.push('--strict-mcp-config');
    }
  }

  appendRepeatedFlag(args, '--allowed-tools', input.requestOptions?.nodeConfig?.allowed_tools);
  appendRepeatedFlag(args, '--disallowed-tools', input.requestOptions?.nodeConfig?.denied_tools);

  if (input.resumeSessionId) {
    args.push('--resume', input.resumeSessionId);
    if (input.requestOptions?.forkSession === true) {
      args.push('--fork-session', '--session-id', sessionId);
    }
  } else {
    args.push('--session-id', sessionId);
  }

  args.push('--', input.prompt);
  return { args, sessionId, warnings };
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      output = appendCapturedOutput(output, decoder.decode(next.value, { stream: true }));
    }
    output = appendCapturedOutput(output, decoder.decode());
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function* streamStdout(stream: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const text = decoder.decode(next.value, { stream: true });
      if (text.length > 0) yield text;
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function preview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 1000) return trimmed;
  return `${trimmed.slice(0, 1000)}...`;
}

function isLoginFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('not logged in') || lower.includes('qodercli login');
}

function buildExitErrorMessage(exitCode: number, stdout: string, stderr: string): string {
  const combined = `${stderr}\n${stdout}`.trim();
  if (isLoginFailure(combined)) {
    return 'Qoder CLI is not logged in. Run `qodercli login` to authenticate, then retry.';
  }
  const detail = preview(combined);
  return detail
    ? `Qoder CLI exited with code ${String(exitCode)}: ${detail}`
    : `Qoder CLI exited with code ${String(exitCode)}.`;
}

async function assertLoggedIn(
  binaryPath: string,
  cwd: string,
  env: Record<string, string>,
  configDir: string | undefined,
  spawn: QoderCliSpawner,
  abortSignal: AbortSignal | undefined
): Promise<void> {
  if (abortSignal?.aborted) {
    throw new Error('Query aborted');
  }
  const args = configDir
    ? [binaryPath, '--config-dir', configDir, 'status', '-o', 'json']
    : [binaryPath, 'status', '-o', 'json'];
  const proc = spawn(args, { cwd, env });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const statusPromise = Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ]);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      killTimer = scheduleKill(proc);
      reject(new Error(`Qoder CLI status timed out after ${String(STATUS_TIMEOUT_MS / 1000)}s.`));
    }, STATUS_TIMEOUT_MS);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    if (!abortSignal) return;
    onAbort = (): void => {
      killTimer = scheduleKill(proc);
      reject(new Error('Query aborted'));
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  let statusCompleted = false;
  try {
    [stdout, stderr, exitCode] = await Promise.race([statusPromise, timeoutPromise, abortPromise]);
    statusCompleted = true;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (killTimer && statusCompleted) clearTimeout(killTimer);
    if (abortSignal && onAbort) {
      abortSignal.removeEventListener('abort', onAbort);
    }
  }

  if (exitCode !== 0) {
    throw new Error(buildExitErrorMessage(exitCode, stdout, stderr));
  }

  try {
    const parsed = JSON.parse(stdout) as { logged_in?: unknown };
    if (parsed.logged_in !== true) {
      throw new Error(
        'Qoder CLI is not logged in. Run `qodercli login` to authenticate, then retry.'
      );
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Qoder CLI status returned invalid JSON: ${preview(stdout)}`);
    }
    throw err;
  }
}

async function resolveMcpConfigJson(
  requestOptions: SendQueryOptions | undefined,
  cwd: string,
  env: Record<string, string>
): Promise<{ json?: string; warnings: ProviderWarning[] }> {
  const mcpPath = requestOptions?.nodeConfig?.mcp;
  if (typeof mcpPath !== 'string' || mcpPath.length === 0) {
    return { warnings: [] };
  }

  const { servers, missingVars } = await loadMcpConfig(mcpPath, cwd, buildMcpEnvSource(env));
  const warnings: ProviderWarning[] = [];
  if (missingVars.length > 0) {
    const uniqueVars = [...new Set(missingVars)];
    warnings.push({
      message: `MCP config references undefined env vars: ${uniqueVars.join(', ')}. These will be empty strings - MCP servers may fail to authenticate.`,
    });
  }
  return { json: JSON.stringify({ mcpServers: servers }), warnings };
}

export class QoderCliProvider implements IAgentProvider {
  private readonly spawn: QoderCliSpawner;

  constructor(options?: { spawn?: QoderCliSpawner }) {
    this.spawn = options?.spawn ?? defaultSpawner;
  }

  getType(): string {
    return 'qodercli';
  }

  getCapabilities(): ProviderCapabilities {
    return QODERCLI_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const qoderConfig = parseQoderCliConfig(assistantConfig);
    const env = buildProviderEnv(requestOptions?.env);
    const binaryPath = await resolveQoderCliBinaryPath(qoderConfig.qodercliBinaryPath, env);

    await assertLoggedIn(
      binaryPath,
      cwd,
      env,
      qoderConfig.configDir,
      this.spawn,
      requestOptions?.abortSignal
    );

    const outputFormat = requestOptions?.outputFormat;
    const wantsStructured = outputFormat?.type === 'json_schema';
    const effectivePrompt = wantsStructured
      ? augmentPromptForJsonSchema(prompt, outputFormat.schema)
      : prompt;
    const mcp = await resolveMcpConfigJson(requestOptions, cwd, env);
    const { args, sessionId, warnings } = buildQoderCliArgs({
      prompt: effectivePrompt,
      cwd,
      config: qoderConfig,
      requestOptions,
      resumeSessionId,
      mcpConfigJson: mcp.json,
    });

    for (const warning of [...mcp.warnings, ...warnings]) {
      yield { type: 'system', content: `⚠️ Warning: ${warning.message}` };
    }

    const command = buildSpawnCommand(binaryPath, args);
    getLog().info(
      {
        cwd,
        model: requestOptions?.model ?? qoderConfig.model,
        reasoningEffort: qoderConfig.modelReasoningEffort,
        resumed: resumeSessionId !== undefined,
        forked: requestOptions?.forkSession === true,
      },
      'qodercli.query_started'
    );

    const proc = this.spawn(command, { cwd, env });
    const stderrPromise = readStream(proc.stderr);
    let stdout = '';
    let processExited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abortSignal = requestOptions?.abortSignal;
    const onAbort = (): void => {
      killTimer = scheduleKill(proc);
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        killTimer = scheduleKill(proc);
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      if (abortSignal?.aborted) {
        throw new Error('Query aborted');
      }
      for await (const chunk of streamStdout(proc.stdout)) {
        stdout = appendCapturedOutput(stdout, chunk);
        yield { type: 'assistant', content: chunk };
      }

      const exitCode = await proc.exited;
      processExited = true;
      const stderr = await stderrPromise;

      if (abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      if (exitCode !== 0) {
        const message = buildExitErrorMessage(exitCode, stdout, stderr);
        yield { type: 'system', content: message };
        yield {
          type: 'result',
          sessionId,
          isError: true,
          errorSubtype: 'qodercli_exit_nonzero',
          errors: [message],
        };
        return;
      }

      const result: MessageChunk = { type: 'result', sessionId };
      if (wantsStructured) {
        const parsed = tryParseStructuredOutput(stdout);
        if (parsed !== undefined) {
          result.structuredOutput = parsed;
        } else {
          getLog().warn(
            { bufferLength: stdout.length, sessionId },
            'qodercli.structured_output_parse_failed'
          );
        }
      }
      yield result;
      getLog().info({ sessionId }, 'qodercli.query_completed');
    } finally {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      if (killTimer && processExited) {
        clearTimeout(killTimer);
      }
      if (!processExited && !killTimer) {
        scheduleKill(proc);
      }
    }
  }
}
