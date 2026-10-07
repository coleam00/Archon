import { expect, test } from 'bun:test';
import { InvalidProviderRunConfigError } from '@archon/provider-contract';
import { processProviderRegistration } from './process-registration';
import { descriptor, parseConfig } from './fixtures/process-provider-data';
const argv = [process.execPath, 'fixture.ts'] as const;

test('strict config parser applies equally to install and run', () => {
  const registration = processProviderRegistration(descriptor, argv);
  expect(registration.builtIn).toBe(false);
  for (const scope of ['install', 'run'] as const) {
    expect(registration.parseConfig({ model: 'model' }, scope)).toEqual({ model: 'model' });
    try {
      registration.parseConfig({ model: 42 }, scope);
      throw new Error('accepted invalid config');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProviderRunConfigError);
      if (error instanceof InvalidProviderRunConfigError) expect(error.fieldPath).toBe('model');
    }
    expect(() => registration.parseConfig({ unknown: true }, scope)).toThrow();
  }
});

test('credential vendor selection follows single-vendor and declared prefix rules', () => {
  expect(processProviderRegistration(descriptor, argv).credentials.vendorFor(undefined)).toBe(
    'openai'
  );
  const registration = processProviderRegistration(
    {
      ...descriptor,
      credentials: {
        kind: 'static',
        specs: [
          ...descriptor.credentials.specs,
          { vendor: 'anthropic', displayName: 'Anthropic', kinds: ['api_key'] },
        ],
      },
    },
    argv
  );
  expect(registration.credentials.vendorFor('anthropic/sonnet')).toBe('anthropic');
  expect(registration.credentials.vendorFor('openai/gpt')).toBe('openai');
  expect(registration.credentials.vendorFor('claude/sonnet')).toBe('anthropic');
  expect(registration.credentials.vendorFor('codex/gpt')).toBe('openai');
  expect(registration.credentials.vendorFor('unknown/model')).toBeUndefined();
  expect(registration.credentials.vendorFor(undefined)).toBeUndefined();
});

test('undeliverable api-key vendors are rejected at registration', () => {
  expect(() =>
    processProviderRegistration(
      {
        ...descriptor,
        credentials: {
          kind: 'static',
          specs: [{ vendor: 'unknown', displayName: 'Unknown', kinds: ['api_key'] }],
        },
      },
      argv
    )
  ).toThrow('process-fixture: no credential delivery rule for unknown');
});

test('scoped wire config agrees with the in-process parser', () => {
  const registration = processProviderRegistration(descriptor, argv);
  for (const scope of ['install', 'run', 'snapshot'] as const) {
    for (const raw of [
      {},
      { model: 'model' },
      { model: 'model', env: { TOKEN: 'private' } },
      { model: 42 },
      { model: '' },
      { env: { TOKEN: 42 } },
      { unknown: true },
      { model: 'model', env: 42 },
    ]) {
      const expected = (() => {
        try {
          return { value: parseConfig(raw, scope) };
        } catch {
          return undefined;
        }
      })();
      if (expected) expect(registration.parseConfig(raw, scope)).toEqual(expected.value);
      else
        expect(() => registration.parseConfig(raw, scope)).toThrow(InvalidProviderRunConfigError);
    }
  }
  expect(
    registration.parseConfig({ model: 'model', env: { TOKEN: 'private' } }, 'snapshot')
  ).toEqual({ model: 'model' });
});

test('legacy v1 descriptors still validate all scopes with configSchema', () => {
  const { config: _config, ...legacy } = descriptor;
  const registration = processProviderRegistration(legacy, argv);
  for (const scope of ['install', 'run', 'snapshot'] as const) {
    expect(registration.parseConfig({ model: 'model' }, scope)).toEqual({ model: 'model' });
    expect(() => registration.parseConfig({ unknown: true }, scope)).toThrow();
  }
});
