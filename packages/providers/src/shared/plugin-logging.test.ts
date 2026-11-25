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
  // The test decides which records reach the sink, not an inherited LOG_LEVEL.
  logger.level = 'info';
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
      lifecycle: 'process_still_exiting',
    },
    'provider.fixture_failed'
  );
  logger.warn({ lifecycle: 'credential-secret' }, 'provider.fixture_warned');
  logger.info(
    { credentialInput: 'delivered', credentialKeys: ['CLAUDE_CODE_OAUTH_TOKEN'] },
    'claude.credential_input'
  );
  logger.info(
    {
      credentialInput: 'forwarded',
      credentialKeys: ['CLAUDE_API_KEY', 'PATH', 'credential-secret'],
    },
    'claude.credential_input'
  );
  logger.info({ credentialKeys: ['CLAUDE_API_KEY'] }, 'provider.fixture_keys');
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
        lifecycle: 'process_still_exiting',
      },
    },
    { level: 'warn', msg: 'provider.fixture_warned', bindings: { module: 'provider.fixture' } },
    {
      level: 'info',
      msg: 'claude.credential_input',
      bindings: {
        module: 'provider.fixture',
        credentialInput: 'delivered',
        credentialKeys: ['CLAUDE_CODE_OAUTH_TOKEN'],
      },
    },
    {
      level: 'info',
      msg: 'claude.credential_input',
      bindings: {
        module: 'provider.fixture',
        credentialInput: 'forwarded',
        credentialKeys: ['CLAUDE_API_KEY'],
      },
    },
    { level: 'info', msg: 'provider.fixture_keys', bindings: { module: 'provider.fixture' } },
  ]);
});
