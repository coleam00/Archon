import { existsSync, writeFileSync } from 'node:fs';
import {
  serveProvider,
  type ProviderPluginDescriptor,
  type ProviderLogSink,
} from '@archon/provider-contract/plugin';

type TestProvider = ReturnType<Parameters<typeof serveProvider>[0]['create']>;

export const descriptor: ProviderPluginDescriptor = {
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
    nativeTools: true,
    containerExec: true,
  },
};

export function createProvider(stateFile?: string, log?: ProviderLogSink): TestProvider {
  return {
    getType: () => descriptor.id,
    getCapabilities: () => descriptor.capabilities,
    checkCredential: async () => ({ state: 'usable', source: 'native' }),
    async *sendQuery(prompt, _cwd, resume, options): ReturnType<TestProvider['sendQuery']> {
      if (prompt === 'parity') {
        await log?.({ level: 'info', msg: 'provider.parity', bindings: { transport: 'ready' } });
        const tool = options?.nativeTools?.[0];
        if (!tool) throw new Error('missing host tool');
        yield {
          type: 'result',
          structuredOutput: {
            tool: await tool.handler({ action: 'inspect', enabled: true }),
            env: options?.env ?? {},
            hostPath: process.env.PATH ?? '',
          },
        };
        yield { type: 'settled' };
        return;
      }
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

export const create = (): TestProvider => createProvider();
if (import.meta.main)
  await serveProvider({ descriptor, create: log => createProvider(process.argv[2], log) });
