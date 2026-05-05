import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { OPENCODE_CAPABILITIES } from './capabilities';

export class OpenCodeProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    _resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const binaryPath = this.resolveBinaryPath(requestOptions);
    const args = ['run', '--format', 'json', '--dir', cwd, prompt];

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
        yield {
          type: 'system',
          content: `OpenCode binary not found: ${binaryPath}. Install opencode or set OPENCODE_BIN_PATH.`,
        };
      } else {
        yield {
          type: 'system',
          content: `Failed to start OpenCode: ${e.message}`,
        };
      }
      return;
    }

    const stdErrStream = childProcess.stderr;
    let stderr = '';
    if (stdErrStream) {
      stdErrStream.on('data', data => {
        stderr += String(data);
      });
    }

    const stdoutStream = childProcess.stdout;
    if (!stdoutStream) {
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
      } catch {
        // Skip non-JSON lines (e.g. stderr interleaved with stdout)
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

    if (lineCount === 0 && childProcess.exitCode !== 0) {
      yield {
        type: 'system',
        content: stderr || `OpenCode exited with code ${childProcess.exitCode}.`,
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
    // The actual event schema is validated at runtime; this is a best-effort mapping.
    const content = event.content ?? event.text ?? event.data ?? event.message;
    if (typeof content === 'string' && content.length > 0) {
      return { type: 'assistant', content };
    }
    return null;
  }
}
