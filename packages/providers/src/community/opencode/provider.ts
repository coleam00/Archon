import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { createLogger } from '@archon/paths';

import { OPENCODE_CAPABILITIES } from './capabilities';

const log = createLogger('opencode');

export class OpenCodeProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    _resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const binaryPath = this.resolveBinaryPath(requestOptions);
    const args = ['run', '--format', 'json', '--dir', cwd, prompt];

    log.info({ binaryPath, cwd, promptLength: prompt.length }, 'opencode.send_query_started');

    let childProcess: ChildProcess;
    try {
      childProcess = spawn(binaryPath, args, {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        log.error({ binaryPath, err: e }, 'opencode.binary_not_found');
        yield {
          type: 'system',
          content: `OpenCode binary not found: ${binaryPath}. Install opencode or set OPENCODE_BIN_PATH.`,
        };
      } else if (e.code === 'EACCES') {
        log.error({ binaryPath, err: e }, 'opencode.binary_permission_denied');
        yield {
          type: 'system',
          content: `Permission denied executing OpenCode: ${binaryPath}. Check file permissions.`,
        };
      } else {
        const message = e.message ?? String(e);
        log.error({ binaryPath, err: e }, 'opencode.spawn_failed');
        yield {
          type: 'system',
          content: `Failed to start OpenCode: ${message}`,
        };
      }
      return;
    }

    let processError = null as Error | null;
    childProcess.on('error', err => {
      processError = err;
    });

    const stdErrStream = childProcess.stderr;
    let stderr = '';
    if (stdErrStream) {
      stdErrStream.on('data', data => {
        stderr += String(data);
      });
    }

    const stdoutStream = childProcess.stdout;
    if (!stdoutStream) {
      log.error({ binaryPath, cwd }, 'opencode.stdout_null');
      childProcess.kill();
      yield { type: 'system', content: 'Failed to read OpenCode output.' };
      return;
    }
    const rl = createInterface({
      input: stdoutStream,
      crlfDelay: Infinity,
    });

    let lineCount = 0;
    for await (const line of rl) {
      lineCount++;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const chunk = this.mapEventToChunk(event);
        if (chunk) yield chunk;
      } catch (err) {
        if (err instanceof SyntaxError) {
          log.debug({ line: line.slice(0, 200) }, 'opencode.non_json_line');
        } else {
          log.warn({ err, line: line.slice(0, 200) }, 'opencode.line_processing_error');
        }
      }
    }

    // Wait for process to fully close
    if (childProcess.exitCode === null) {
      await new Promise<void>(resolve => {
        childProcess.once('close', () => {
          resolve();
        });
      });
    }

    if (childProcess.exitCode !== 0) {
      log.warn(
        { lineCount, exitCode: childProcess.exitCode, stderr: stderr.slice(0, 500) },
        'opencode.non_zero_exit'
      );
      yield {
        type: 'system',
        content: stderr
          ? `OpenCode error (exit ${childProcess.exitCode}): ${stderr.slice(0, 1000)}`
          : `OpenCode exited with code ${childProcess.exitCode}.`,
      };
    } else {
      log.info({ lineCount, exitCode: childProcess.exitCode }, 'opencode.send_query_completed');
    }

    if (processError) {
      log.warn({ err: processError }, 'opencode.process_error_event');
      yield {
        type: 'system',
        content: `OpenCode process error: ${processError.message}`,
      };
    }
  }

  getType(): string {
    return 'opencode';
  }

  getCapabilities(): ProviderCapabilities {
    return OPENCODE_CAPABILITIES;
  }

  private resolveBinaryPath(requestOptions?: SendQueryOptions): string {
    const configPath = requestOptions?.assistantConfig?.opencodeBinaryPath;
    if (typeof configPath === 'string' && configPath.length > 0) {
      return configPath;
    }
    return process.env.OPENCODE_BIN_PATH || 'opencode';
  }

  private mapEventToChunk(event: Record<string, unknown>): MessageChunk | null {
    // Map known OpenCode JSON event fields to MessageChunk.
    // The actual event schema is NOT validated; this is a best-effort mapping.
    const content = event.content ?? event.text ?? event.data ?? event.message;
    if (typeof content === 'string' && content.length > 0) {
      return { type: 'assistant', content };
    }
    return null;
  }
}
