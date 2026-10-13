import type { IAgentProvider, SendQueryOptions } from '../../agent-provider';
import type { CredentialStatus } from '../../credential-status';
import type { ProviderChunk } from '../../events';
import type { ProviderPluginDescriptor } from '../wire';

export const descriptor: ProviderPluginDescriptor = {
  protocol: 1,
  id: 'test-provider',
  displayName: 'Test provider',
  version: '1',
  configSchema: { type: 'object', properties: { model: { type: 'string' } } },
  credentials: {
    kind: 'static',
    specs: [{ vendor: 'test', displayName: 'Test', kinds: ['api_key'] }],
  },
  capabilities: {
    backgroundWork: 'reported',
    sessionResume: true,
    mcp: true,
    hooks: true,
    skills: true,
    plugins: true,
    agents: true,
    toolRestrictions: true,
    structuredOutput: 'enforced',
    requiresAllPropertiesRequired: false,
    envInjection: true,
    costControl: true,
    costReporting: true,
    effortControl: true,
    fallbackModel: true,
    sandbox: true,
    settingSources: false,
    nativeTools: false,
    containerExec: false,
  },
};

export const chunks: ProviderChunk[] = [
  { type: 'agent_message_chunk', text: 'Whole text block 🦊\nwith newline' },
  { type: 'agent_thought_chunk', text: 'Thinking' },
  { type: 'state_update', state: 'running' },
  { type: 'tool_call', toolCallId: 'one', name: 'Read' },
  {
    type: 'tool_call_update',
    toolCallId: 'one',
    status: 'completed',
    output: 'file contents',
    exitCode: 0,
  },
  { type: 'tool_call', toolCallId: 'two', name: 'Bash' },
  { type: 'tool_call_update', toolCallId: 'two', status: 'cancelled' },
  { type: 'warning', code: 'test.warning', message: 'Warning' },
  { type: 'mcp_server_status', server: 'test', status: 'connected' },
  { type: 'compaction', phase: 'completed', trigger: 'auto', tokensBefore: 42, tokensAfter: 21 },
  { type: 'hook', hookId: 'hook', hookName: 'Test', hookEvent: 'PreToolUse', status: 'succeeded' },
  {
    type: 'subtask',
    taskId: 'background',
    status: 'started',
    taskType: 'local_agent',
    parentToolCallId: 'one',
  },
  {
    type: 'result',
    sessionId: 'native-session',
    text: 'Reply',
    stopReason: 'end_turn',
    tokens: { input: 12, output: 3, cacheRead: 2, total: 15, cost: 0.01 },
    cost: 0.01,
    numTurns: 1,
    resolvedModel: { id: 'test-model' },
    structuredOutput: { ok: true },
  },
  {
    type: 'subtask',
    taskId: 'background',
    status: 'running',
    summary: 'Still working',
    usage: { tokens: 5 },
  },
  {
    type: 'subtask',
    taskId: 'background',
    status: 'completed',
    summary: 'Done',
    outputFile: '/tmp/output',
  },
  { type: 'settled' },
];

export function fixtureProvider(overrides: Partial<IAgentProvider> = {}): IAgentProvider {
  return {
    getType: () => descriptor.id,
    getCapabilities: () => descriptor.capabilities,
    checkCredential: async () => ({ state: 'usable', source: 'native' }),
    resolveCredentialModel: async request => request.model ?? 'credential-model',
    async *sendQuery(
      prompt: string,
      _cwd: string,
      _resume?: string,
      _options?: SendQueryOptions
    ): AsyncGenerator<ProviderChunk> {
      if (prompt === 'failure') {
        yield { type: 'result', isError: true, failure: { class: 'auth', evidence: 'HTTP 401' } };
        yield { type: 'settled' };
      } else {
        yield* chunks;
      }
    },
    ...overrides,
  };
}

export const credentialStatuses: CredentialStatus[] = [
  { state: 'usable', source: 'native' },
  { state: 'not_connected', source: 'archon' },
  { state: 'unusable', source: 'native', evidence: 'HTTP 401' },
  { state: 'check_failed', source: 'archon', evidence: 'Network unavailable' },
  { state: 'not_checked', source: 'native' },
];
