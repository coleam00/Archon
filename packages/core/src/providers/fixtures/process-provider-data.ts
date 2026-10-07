import { z } from 'zod';
import type { ProviderConfigScope } from '@archon/provider-contract';
import { providerPluginDescriptorSchema } from '@archon/provider-contract/plugin';
import type { ProviderChunk } from '@archon/provider-contract';

const modelFields = { model: z.string().min(1).optional() };
const configSchemas = {
  install: z.strictObject({ ...modelFields, env: z.record(z.string(), z.string()).optional() }),
  run: z.strictObject(modelFields),
  snapshot: z.object(modelFields),
};
export function parseConfig(
  raw: Record<string, unknown>,
  scope: ProviderConfigScope
): Record<string, unknown> {
  return configSchemas[scope].parse(raw);
}

export const descriptor = providerPluginDescriptorSchema.parse({
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
  config: {
    install: z.toJSONSchema(configSchemas.install, { io: 'input' }),
    run: z.toJSONSchema(configSchemas.run, { io: 'input' }),
    snapshot: z.toJSONSchema(configSchemas.snapshot, { io: 'input' }),
    snapshotKeys: Object.keys(configSchemas.snapshot.shape),
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
});
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
