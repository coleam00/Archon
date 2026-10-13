import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRunAiConfiguration, assertRunCredentials } from '@archon/workflows/run-preflight';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import { processProviderRegistration } from './process-registration';
import { descriptor } from './fixtures/process-provider-data';

test('run preflight resolves the model and checks credentials through a process registration', async () => {
  const registration = processProviderRegistration(descriptor, [
    process.execPath,
    join(import.meta.dir, 'fixtures/process-provider.ts'),
  ]);
  const workflow = makeTestResolvedWorkflow({
    name: 'process-preflight',
    nodes: [{ id: 'agent', prompt: 'turn', provider: descriptor.id }],
  });
  const deps = {
    providers: {
      get: (id: string) => (id === registration.id ? registration : undefined),
      list: () => [registration],
    },
    loadConfig: async () => ({
      assistant: descriptor.id,
      assistants: { claude: {}, codex: {}, [descriptor.id]: {} },
      commands: {},
      envVars: { TEST_CREDENTIAL: 'present-value' },
    }),
    store: { getCodebaseEnvVars: async () => ({}) },
    getAgentProvider: () => registration.factory(),
  };
  const prepared = await prepareRunAiConfiguration(deps, workflow, tmpdir());
  expect(prepared.requirements).toEqual([
    { provider: descriptor.id, model: 'openai/native-model', vendor: 'openai' },
  ]);
  await assertRunCredentials(deps, prepared);
  prepared.config.envVars = { TEST_CREDENTIAL: '' };
  await expect(assertRunCredentials(deps, prepared)).rejects.toThrow('no usable login');
});
