import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
  TokenUsage,
} from '../../types';

import { HERMES_CAPABILITIES } from './capabilities';
import { parseHermesConfig } from './config';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.hermes');
  return cachedLog;
}

async function resolveHermesBinaryPath(configPath?: string): Promise<string> {
  const envPath = process.env.HERMES_BIN_PATH;
  if (envPath) {
    if (existsSync(envPath)) return envPath;
    getLog().warn({ path: envPath }, 'HERMES_BIN_PATH does not exist, falling back');
  }

  if (configPath) {
    const absolute = isAbsolute(configPath) ? configPath : resolve(configPath);
    if (existsSync(absolute)) return absolute;
    getLog().warn({ path: absolute }, 'config hermesBinaryPath does not exist, falling back');
  }

  return 'hermes';
}

function extractSessionId(line: string): string | undefined {
  const match = line.match(/^session_id:\s*(.+)$/);
  return match ? match[1].trim() : undefined;
}

function buildHermesArgv(
  binary: string,
  prompt: string,
  cwd: string,
  options: SendQueryOptions,
  config: ReturnType<typeof parseHermesConfig>
): { argv: string[]; env: NodeJS.ProcessEnv } {
  const systemPrompt = options.systemPrompt ?? options.nodeConfig?.systemPrompt;
  const effectivePrompt = systemPrompt
    ? `${systemPrompt}\n\n---\n\n${prompt}`
    : prompt;

  const argv = [binary, 'chat', '-q', effectivePrompt, '--quiet', '--source', 'tool'];

  const model = options.model ?? config.model;
  if (model) {
    argv.push('--model', model);
  }

  if (config.provider) {
    argv.push('--provider', config.provider);
  }

  const toolsets = options.nodeConfig?.allowed_tools
    ? (Array.isArray(options.nodeConfig.allowed_tools)
        ? options.nodeConfig.allowed_tools.join(',')
        : String(options.nodeConfig.allowed_tools))
    : config.toolsets;
  if (toolsets) {
    argv.push('--toolsets', toolsets);
  }

  const skills = options.nodeConfig?.skills ?? config.skills;
  if (skills && skills.length > 0) {
    argv.push('--skills', skills.join(','));
  }

  if (config.maxTurns !== undefined && config.maxTurns > 0) {
    argv.push('--max-turns', String(config.maxTurns));
  }

  if (config.yolo) argv.push('--yolo');
  if (config.checkpoints) argv.push('--checkpoints');
  if (config.worktree) argv.push('--worktree');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.env ?? {}),
    ...(options.env ?? {}),
  };

  return { argv, env };
}

export class HermesProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const hermesConfig = parseHermesConfig(assistantConfig);

    const binary = await resolveHermesBinaryPath(hermesConfig.hermesBinaryPath);
    const { argv, env } = buildHermesArgv(binary, prompt, cwd, requestOptions ?? {}, hermesConfig);

    if (resumeSessionId) {
      argv.push('--resume', resumeSessionId);
    }

    getLog().info(
      {
        binary,
        model: requestOptions?.model ?? hermesConfig.model,
        cwd,
        toolsets: hermesConfig.toolsets,
        skillCount: hermesConfig.skills?.length ?? 0,
        resumeSessionId: resumeSessionId ?? null,
      },
      'hermes.session_started'
    );

    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Handle spawn errors (e.g. binary not found) before streaming begins
    const spawnError = await new Promise<Error | null>((resolve) => {
      child.on('error', (err) => resolve(err));
      // If no error within next tick, resolve null
      setImmediate(() => resolve(null));
    });

    if (spawnError) {
      getLog().error({ err: spawnError, binary: argv[0] }, 'hermes.spawn_failed');
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'spawn_failed',
        errors: [`Failed to spawn hermes: ${spawnError.message}`],
        stopReason: 'spawn_failed',
      };
      return;
    }

    let sessionId: string | undefined;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let exitCode: number | null = null;

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf-8');
    });

    const stdoutIterator = child.stdout!;
    for await (const chunk of stdoutIterator) {
      const text = chunk.toString('utf-8');
      stdoutBuffer += text;

      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const sid = extractSessionId(line);
        if (sid) {
          sessionId = sid;
          continue;
        }
        if (line.length > 0) {
          yield { type: 'assistant', content: line + '\n' };
        }
      }
    }

    if (stdoutBuffer.length > 0) {
      const sid = extractSessionId(stdoutBuffer);
      if (sid) {
        sessionId = sid;
      } else {
        yield { type: 'assistant', content: stdoutBuffer };
      }
    }

    exitCode = await new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
    });

    const isError = exitCode !== 0;
    let errorSubtype: string | undefined;
    if (isError) {
      const stderr = stderrBuffer.toLowerCase();
      if (stderr.includes('rate limit') || stderr.includes('429') || stderr.includes('too many requests')) {
        errorSubtype = 'rate_limit';
      } else if (stderr.includes('auth') || stderr.includes('unauthorized') || stderr.includes('401') || stderr.includes('403')) {
        errorSubtype = 'auth';
      } else if (stderr.includes('model') && (stderr.includes('not found') || stderr.includes('not available') || stderr.includes('access denied'))) {
        errorSubtype = 'model_access';
      } else if (stderr.includes('crash') || stderr.includes('panic') || stderr.includes('segmentation')) {
        errorSubtype = 'crash';
      } else {
        errorSubtype = 'unknown';
      }

      getLog().error(
        { exitCode, errorSubtype, stderrPreview: stderrBuffer.slice(0, 500) },
        'hermes.session_error'
      );
    }

    const tokens: TokenUsage | undefined = undefined;
    yield {
      type: 'result',
      sessionId,
      tokens,
      isError,
      errorSubtype,
      ...(stderrBuffer.length > 0 ? { errors: [stderrBuffer] } : {}),
      stopReason: exitCode === 0 ? 'completed' : `exit_code_${exitCode}`,
    };
  }

  getType(): string {
    return 'hermes';
  }

  getCapabilities(): ProviderCapabilities {
    return HERMES_CAPABILITIES;
  }
}
