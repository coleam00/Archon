import type { IAgentProvider, MessageChunk, SendQueryOptions } from '../../types';

import { runLocalCliProvider, type LocalCliCommand } from '../local-cli/provider';

import { KIRO_CAPABILITIES } from './capabilities';
import { parseKiroConfig } from './config';

function buildKiroCommand(
  model: string | undefined,
  resumeSessionId: string | undefined,
  requestOptions: SendQueryOptions | undefined
): LocalCliCommand {
  const config = parseKiroConfig(requestOptions?.assistantConfig ?? {});
  const args = ['chat', '--no-interactive', '--wrap', 'never'];
  const selectedModel = requestOptions?.model ?? model ?? config.model;

  if (resumeSessionId) args.push('--resume-id', resumeSessionId);
  if (selectedModel) args.push('--model', selectedModel);
  if (config.agent) args.push('--agent', config.agent);
  if (config.trustAllTools) args.push('--trust-all-tools');
  if (config.trustTools) args.push(`--trust-tools=${config.trustTools.join(',')}`);
  if (config.requireMcpStartup) args.push('--require-mcp-startup');
  if (config.additionalArgs) args.push(...config.additionalArgs);

  return {
    command: config.binaryPath ?? 'kiro-cli',
    args,
    promptMode: 'arg',
  };
}

export class KiroProvider implements IAgentProvider {
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const command = buildKiroCommand(requestOptions?.model, resumeSessionId, requestOptions);
    return runLocalCliProvider({ providerId: 'kiro', prompt, cwd, command, requestOptions });
  }

  getType(): string {
    return 'kiro';
  }

  getCapabilities(): typeof KIRO_CAPABILITIES {
    return KIRO_CAPABILITIES;
  }
}
