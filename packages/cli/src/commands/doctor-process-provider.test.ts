import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { processProviderRegistration } from '@archon/core';
import { descriptor } from '../../../core/src/providers/fixtures/process-provider-data';
import { checkAssistantLogin } from './doctor';

test('doctor gets credential status through a process-backed registration', async () => {
  const registration = processProviderRegistration(descriptor, [
    process.execPath,
    resolve(import.meta.dir, '../../../core/src/providers/fixtures/process-provider.ts'),
  ]);
  const load = async () => ({
    assistant: registration.id,
    model: 'openai/model',
    vendor: 'openai',
    connectedVendors: [],
    provider: registration.factory(),
  });
  expect((await checkAssistantLogin({ TEST_CREDENTIAL: 'present-value' }, load)).status).toBe(
    'pass'
  );
  expect((await checkAssistantLogin({ TEST_CREDENTIAL: '' }, load)).status).toBe('fail');
});
