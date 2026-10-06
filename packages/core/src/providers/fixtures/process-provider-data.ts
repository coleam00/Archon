import type { ProviderPluginDescriptor } from '@archon/provider-contract/plugin';
import type { ProviderChunk } from '@archon/provider-contract';

export const descriptor: ProviderPluginDescriptor = {
  protocol: 1,
  id: 'process-fixture',
  displayName: 'Process fixture',
  version: '1',
  credentials: {
    kind: 'static',
    specs: [{ vendor: 'openai', displayName: 'OpenAI', kinds: ['api_key'] }],
  },
  configSchema: {
    type: 'object',
    properties: { model: { type: 'string' } },
    additionalProperties: false,
  },
  capabilities: {
    backgroundWork: 'reported',
    sessionResume: true,
    mcp: false,
    hooks: false,
    skills: false,
    plugins: false,
    agents: false,
    toolRestrictions: false,
    structuredOutput: false,
    requiresAllPropertiesRequired: false,
    envInjection: true,
    costControl: false,
    costReporting: false,
    effortControl: false,
    fallbackModel: false,
    sandbox: false,
    settingSources: false,
    nativeTools: false,
    containerExec: false,
  },
};
export const chunks: ProviderChunk[] = [
  { type: 'subtask', taskId: 'background', status: 'started' },
  {
    type: 'result',
    text: 'Reply 🦊',
    sessionId: 'native-session',
    tokens: { input: 3, output: 2, total: 5 },
  },
  { type: 'subtask', taskId: 'background', status: 'running' },
  { type: 'subtask', taskId: 'background', status: 'completed' },
  { type: 'settled' },
];
