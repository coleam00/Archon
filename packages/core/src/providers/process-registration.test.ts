import { expect, test } from 'bun:test';
import { z } from 'zod';
import { providerPluginDescriptorSchema } from '@archon/provider-contract/plugin';
import { InvalidProviderRunConfigError } from '@archon/provider-contract';
import { processProviderRegistration } from './process-registration';
import { claudeDescriptor, codexDescriptor, piDescriptor } from '@archon/providers';
import { parseClaudeConfigStrict } from '@archon/providers/claude/config';
import { parseCodexConfigStrict } from '@archon/providers/codex/config';
import { parsePiConfigStrict } from '@archon/providers/pi/config';
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

test('snapshot projection retains every schema-declared field without a separate key list', () => {
  const rawDescriptor = providerPluginDescriptorSchema.parse({
    ...descriptor,
    config: { ...descriptor.config, snapshotKeys: [] },
  });
  const registration = processProviderRegistration(rawDescriptor, argv);
  expect(registration.parseConfig({ model: 'model', secret: 'private' }, 'snapshot')).toEqual({
    model: 'model',
  });
});

test('recursive scoped stripping agrees for nested properties, array items and record values', () => {
  const item = z.object({ enabled: z.boolean() });
  const fields = {
    nested: item,
    items: z.array(item),
    records: z.record(z.string(), item),
    scalars: z.record(z.string(), z.string()),
    passthrough: z.looseObject({ enabled: z.boolean() }),
    strict: z.strictObject({ enabled: z.boolean() }),
    choice: z.union([z.object({ left: z.string() }), z.object({ right: z.string() })]),
    combined: z.intersection(z.object({ left: z.string() }), z.object({ right: z.string() })),
    tuple: z.tuple([item]),
  };
  const schemas = {
    install: z.strictObject(fields),
    run: z.strictObject(fields),
    snapshot: z.object(fields),
  };
  const registration = processProviderRegistration(
    providerPluginDescriptorSchema.parse({
      ...descriptor,
      config: {
        install: z.toJSONSchema(schemas.install, { io: 'input' }),
        run: z.toJSONSchema(schemas.run, { io: 'input' }),
        snapshot: z.toJSONSchema(schemas.snapshot, { io: 'input' }),
        stripUnknownKeys: true,
      },
    }),
    argv
  );
  const raw = {
    nested: { enabled: true, secret: 'private' },
    items: [{ enabled: false, secret: 'private' }],
    records: { arbitrary: { enabled: true, secret: 'private' } },
    scalars: { arbitrary: 'retained' },
    passthrough: { enabled: true, retained: 'retained' },
    strict: { enabled: true },
    choice: { right: 'retained', secret: 'private' },
    combined: { left: 'left', right: 'right', secret: 'private' },
    tuple: [{ enabled: true, secret: 'private' }],
  };
  for (const scope of ['install', 'run', 'snapshot'] as const) {
    expect(registration.parseConfig(raw, scope)).toEqual(schemas[scope].parse(raw));
    for (const invalid of [
      { ...raw, nested: { enabled: 'invalid' } },
      { ...raw, items: [{ enabled: 'invalid' }] },
      { ...raw, records: { arbitrary: { enabled: 'invalid' } } },
      { ...raw, strict: { enabled: true, unknown: true } },
    ]) {
      expect(schemas[scope].safeParse(invalid).success).toBe(false);
      expect(() => registration.parseConfig(invalid, scope)).toThrow(InvalidProviderRunConfigError);
    }
    const extra = { ...raw, secret: 'private' };
    if (scope === 'snapshot')
      expect(registration.parseConfig(extra, scope)).toEqual(schemas.snapshot.parse(extra));
    else
      expect(() => registration.parseConfig(extra, scope)).toThrow(InvalidProviderRunConfigError);
  }
});

test('scoped projection follows references and pattern-valued objects from a JSON descriptor', () => {
  const schema = {
    type: 'object',
    $defs: {
      entry: { type: 'object', properties: { enabled: { type: 'boolean' } } },
    },
    properties: {
      referenced: { $ref: '#/$defs/entry' },
      patterned: {
        type: 'object',
        patternProperties: { '^entry-': { $ref: '#/$defs/entry' } },
      },
    },
  };
  const registration = processProviderRegistration(
    providerPluginDescriptorSchema.parse({
      ...descriptor,
      config: { install: schema, run: schema, snapshot: schema, stripUnknownKeys: true },
    }),
    argv
  );
  for (const scope of ['install', 'run', 'snapshot'] as const) {
    expect(
      registration.parseConfig(
        {
          referenced: { enabled: true, secret: 'private' },
          patterned: { 'entry-one': { enabled: false, secret: 'private' }, unknown: 'private' },
        },
        scope
      )
    ).toEqual({
      referenced: { enabled: true },
      patterned: { 'entry-one': { enabled: false } },
    });
  }
});

for (const { descriptor: maintained, raw, canonical, snapshot, discardedInvalid, inProcess } of [
  {
    descriptor: claudeDescriptor,
    inProcess: parseClaudeConfigStrict,
    raw: { model: '  sonnet  ', claudeBinaryPath: '  /binary  ', settingSources: ['project'] },
    canonical: { model: 'sonnet', claudeBinaryPath: '/binary', settingSources: ['project'] },
    snapshot: { model: 'sonnet' },
    discardedInvalid: { claudeBinaryPath: ' ' },
  },
  {
    descriptor: codexDescriptor,
    inProcess: parseCodexConfigStrict,
    raw: {
      model: '  gpt-5  ',
      codexBinaryPath: '  /binary  ',
      modelReasoningEffort: 'high',
      webSearchMode: 'live',
      additionalDirectories: [' /repo '],
    },
    canonical: {
      model: 'gpt-5',
      codexBinaryPath: '/binary',
      modelReasoningEffort: 'high',
      webSearchMode: 'live',
      additionalDirectories: [' /repo '],
    },
    snapshot: { model: 'gpt-5', modelReasoningEffort: 'high' },
    discardedInvalid: { codexBinaryPath: ' ' },
  },
  {
    descriptor: piDescriptor,
    inProcess: parsePiConfigStrict,
    raw: {
      model: '  openrouter / qwen/qwen3-coder  ',
      enableExtensions: false,
      nodes: { plan: { interactive: true } },
      extensionFlags: { label: ' keep spaces ' },
    },
    canonical: {
      model: 'openrouter/qwen/qwen3-coder',
      enableExtensions: false,
      nodes: { plan: { interactive: true } },
      extensionFlags: { label: ' keep spaces ' },
    },
    snapshot: {
      model: 'openrouter/qwen/qwen3-coder',
      enableExtensions: false,
      nodes: { plan: { interactive: true } },
      extensionFlags: { label: ' keep spaces ' },
    },
    discardedInvalid: { env: { TOKEN: 1 } },
  },
]) {
  test(`${maintained.id} snapshots reject unknown settings and validate excluded local settings`, () => {
    const registration = processProviderRegistration(JSON.parse(JSON.stringify(maintained)), argv);
    for (const invalid of [{ unknown: true }, discardedInvalid]) {
      expect(() => inProcess(invalid, 'snapshot')).toThrow(InvalidProviderRunConfigError);
      expect(() => registration.parseConfig(invalid, 'snapshot')).toThrow(
        InvalidProviderRunConfigError
      );
    }
  });

  test(`${maintained.id} process registration preserves canonical output in every scope`, () => {
    const registration = processProviderRegistration(JSON.parse(JSON.stringify(maintained)), argv);
    for (const scope of ['install', 'run', 'snapshot'] as const) {
      const expected = scope === 'snapshot' ? snapshot : canonical;
      expect(registration.parseConfig(raw, scope)).toEqual(expected);
      expect(registration.parseConfig(raw, scope)).toEqual(inProcess(raw, scope));
      expect(() => registration.parseConfig({ ...raw, unknown: true }, scope)).toThrow(
        InvalidProviderRunConfigError
      );
    }
    if (maintained.id === piDescriptor.id) {
      const emptyRecords = { extensionFlags: {}, nodes: { plan: {} } };
      for (const scope of ['install', 'run', 'snapshot'] as const) {
        expect(registration.parseConfig(emptyRecords, scope)).toEqual(
          inProcess(emptyRecords, scope)
        );
      }
      const install = { ...raw, env: { TOKEN: 'private' }, maxConcurrent: 2 };
      expect(registration.parseConfig(install, 'install')).toEqual({
        ...canonical,
        env: { TOKEN: 'private' },
        maxConcurrent: 2,
      });
      expect(registration.parseConfig(install, 'snapshot')).toEqual(snapshot);
      expect(() => registration.parseConfig(install, 'run')).toThrow(InvalidProviderRunConfigError);
    }
  });
}
