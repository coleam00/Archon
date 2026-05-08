import { spawn } from 'bun';
import type {
  IAgentProvider,
  SendQueryOptions,
  MessageChunk,
  ProviderCapabilities,
} from '../types';
import { OPENCODE_CAPABILITIES } from './capabilities';
import { createLogger } from '@archon/paths';

const log = createLogger('provider.opencode');

export class OpenCodeProvider implements IAgentProvider {
  private readonly binaryPath = '/home/aatchison/.opencode/bin/opencode';

  getType(): string {
    return 'opencode';
  }

  getCapabilities(): ProviderCapabilities {
    return OPENCODE_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const args = ['run'];
    
    if (resumeSessionId) {
      args.push('--session', resumeSessionId);
    }

    if (options?.model) {
      args.push('--model', options.model);
    }

    args.push(prompt);

    log.info({ args, cwd }, 'opencode.query_started');

    const processEnv = globalThis.process?.env || {};
    const child = spawn([this.binaryPath, ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...processEnv, ...options?.env },
    });

    const stdout = child.stdout;

    try {
      for await (const chunk of stdout) {
        const text = new TextDecoder().decode(chunk).trim();
        if (text) {
          yield { type: 'assistant', content: text };
        }
      }
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
    }
  }
}
