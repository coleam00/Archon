import { z } from 'zod';
import { existsSync, writeFileSync } from 'node:fs';
import { serveProvider, providerPluginDescriptorSchema } from '@archon/provider-contract/plugin';

type TestProvider = ReturnType<Parameters<typeof serveProvider>[0]['create']>;

const modelFields = { model: z.string().min(1).optional() };
const configSchemas = {
  install: z.strictObject({ ...modelFields, env: z.record(z.string(), z.string()).optional() }),
  run: z.strictObject(modelFields),
  snapshot: z.object(modelFields),
};
export const descriptor = providerPluginDescriptorSchema.parse({
  protocol: 1,
  id: 'test-provider',
  displayName: 'Test provider',
  version: '1',
  credentials: { kind: 'static', specs: [] },
  configSchema: {
    type: 'object',
    properties: { model: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  },
  config: {
    install: z.toJSONSchema(configSchemas.install, { io: 'input' }),
    run: z.toJSONSchema(configSchemas.run, { io: 'input' }),
    snapshot: z.toJSONSchema(configSchemas.snapshot, { io: 'input' }),
    stripUnknownKeys: true,
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
    structuredOutput: 'enforced',
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

export function createProvider(stateFile?: string): TestProvider {
  return {
    getType: () => descriptor.id,
    getCapabilities: () => descriptor.capabilities,
    diagnose: async ({ assistantConfig }) => ({
      checks: [
        {
          id: 'configuration',
          label: 'Configuration',
          status: assistantConfig?.model ? 'ok' : 'skip',
          message: 'Configuration inspected',
          remedy: 'Select a model',
        },
      ],
    }),
    listModels: async () => ({
      models: [{ id: 'fixture/model', label: 'Fixture model' }, { id: 'fixture/other' }],
    }),
    checkCredential: async () => ({ state: 'usable', source: 'native' }),
    async *sendQuery(prompt, _cwd, resume, options): ReturnType<TestProvider['sendQuery']> {
      if (prompt === 'failure') {
        yield { type: 'result', isError: true, failure: { class: 'auth', evidence: 'HTTP 401' } };
        yield { type: 'settled' };
        return;
      }
      if (prompt === 'background' && stateFile) writeFileSync(stateFile, 'running');
      if (prompt === 'background')
        yield { type: 'subtask', taskId: 'test-task', status: 'started' };
      yield {
        type: 'result',
        text: prompt,
        sessionId: resume ?? 'test-session',
        tokens: { input: 3, output: 2, total: 5 },
        ...(options?.outputFormat ? { structuredOutput: { echo: prompt } } : {}),
      };
      if (prompt === 'background') {
        yield { type: 'subtask', taskId: 'test-task', status: 'running' };
        if (stateFile) {
          while (!existsSync(`${stateFile}.ack`)) await Bun.sleep(5);
          writeFileSync(stateFile, 'completed');
        }
        yield { type: 'subtask', taskId: 'test-task', status: 'completed' };
      }
      yield { type: 'settled' };
    },
  };
}

export const create: Parameters<typeof serveProvider>[0]['create'] = () => createProvider();
if (import.meta.main)
  await serveProvider({ descriptor, create: () => createProvider(process.argv[2]) });
