import { afterEach, expect, test } from 'bun:test';
import { createLogger, setLogSink, setLogDestination } from '@archon/paths';
import type { ProviderLog } from '@archon/provider-contract/plugin';
import { installProviderLogSink } from './plugin-logging';

afterEach(() => {
  setLogSink(undefined);
  setLogDestination('stdout');
});

test('RPC logging redirects existing loggers and strips SDK payloads, credentials and message text', async () => {
  const logger = createLogger('provider.fixture');
  const records: ProviderLog[] = [];
  installProviderLogSink(async record => {
    records.push(record);
  });
  logger.error(
    {
      err: new Error('credential-secret'),
      text: 'message-text',
      token: 'token-secret',
      input: { prompt: 'message-text' },
      count: 2,
      resultReported: false,
      failureClass: 'auth',
    },
    'provider.fixture_failed'
  );
  await Promise.resolve();
  expect(records).toEqual([
    {
      level: 'error',
      msg: 'provider.fixture_failed',
      bindings: {
        module: 'provider.fixture',
        count: 2,
        resultReported: false,
        failureClass: 'auth',
      },
    },
  ]);
});
