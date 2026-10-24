import { assertRunCredentials, prepareRunAiConfiguration } from '@archon/workflows/run-preflight';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import { expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { providerPluginDescriptorSchema } from '@archon/provider-contract/plugin';
import { InvalidProviderRunConfigError, normalizedConfigString } from '@archon/provider-contract';
import { processProviderRegistration } from '../process-registration';
import { claudeDescriptor, codexDescriptor, piDescriptor } from '@archon/providers';
import { parseClaudeConfigStrict } from '@archon/providers/claude/config';
import { parseCodexConfigStrict } from '@archon/providers/codex/config';
import { parsePiConfigStrict } from '@archon/providers/pi/config';
import { descriptor } from '../fixtures/process-provider-data';
import {
  argv,
  assertSelectedProjection,
  modelLookupRegistration,
} from './process-registration-fixtures';
export function registerProjectionTests() {
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
        expect(() => registration.parseConfig(invalid, scope)).toThrow(
          InvalidProviderRunConfigError
        );
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
      const registration = processProviderRegistration(
        JSON.parse(JSON.stringify(maintained)),
        argv
      );
      for (const invalid of [{ unknown: true }, discardedInvalid]) {
        expect(() => inProcess(invalid, 'snapshot')).toThrow(InvalidProviderRunConfigError);
        expect(() => registration.parseConfig(invalid, 'snapshot')).toThrow(
          InvalidProviderRunConfigError
        );
      }
    });

    test(`${maintained.id} process registration preserves canonical output in every scope`, () => {
      const registration = processProviderRegistration(
        JSON.parse(JSON.stringify(maintained)),
        argv
      );
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
        expect(() => registration.parseConfig(install, 'run')).toThrow(
          InvalidProviderRunConfigError
        );
      }
    });
  }

  test('process Pi credential selection normalizes every declared vendor model', () => {
    const registration = processProviderRegistration(piDescriptor, argv);
    for (const spec of piDescriptor.credentials.specs) {
      expect(registration.credentials.vendorFor(`  ${spec.vendor} / model/name  `)).toBe(
        spec.vendor
      );
    }
    expect(registration.credentials.vendorFor(' malformed ')).toBeUndefined();
  });

  test('whitespace Pi models preflight the stored vendor credential instead of native auth', async () => {
    const registration = processProviderRegistration(piDescriptor, argv);
    const native = registration.factory();
    const checkCredential = mock(native.checkCredential.bind(native));
    native.checkCredential = checkCredential;
    const getUserProviderCredential = mock(async (_user: string, _vendor: string) => ({
      kind: 'api_key' as const,
      getStatus: async () => ({ state: 'usable' as const, source: 'archon' as const }),
    }));
    const providers = {
      get: (id: string) => (id === 'pi' ? registration : undefined),
      list: () => [registration],
    };
    const deps = {
      providers,
      loadConfig: async () => ({
        assistant: 'pi',
        assistants: { claude: {}, codex: {}, pi: { model: '  google / gemini-2.5-pro  ' } },
        commands: {},
      }),
      store: { getCodebaseEnvVars: async () => ({}) },
      getAgentProvider: () => native,
      isPerUserProviderKeysEnabled: () => true,
      getUserProviderCredential,
    };
    const prepared = await prepareRunAiConfiguration(
      deps,
      makeTestResolvedWorkflow({ name: 'pi-credentials' }),
      '/project',
      { userId: 'user' }
    );
    expect(prepared.requirements).toEqual([
      { provider: 'pi', model: 'google/gemini-2.5-pro', vendor: 'google' },
    ]);
    const model = '  google / gemini-2.5-pro  ';
    await assertRunCredentials(
      deps,
      {
        ...prepared,
        requirements: [
          { provider: 'pi', model, vendor: registration.credentials.vendorFor(model) },
        ],
      },
      { cwd: '/project' }
    );
    expect(getUserProviderCredential).toHaveBeenCalledWith('user', 'google');
    expect(checkCredential).not.toHaveBeenCalled();
  });

  test.each(
    (['$ref', 'allOf', 'anyOf', 'oneOf'] as const).flatMap(composition =>
      [false, true].flatMap(required =>
        [false, true].map(stripUnknownKeys => ({ composition, required, stripUnknownKeys }))
      )
    )
  )(
    '$composition typed wrappers retain branch fields (required: $required, strip: $stripUnknownKeys)',
    ({ composition, required, stripUnknownKeys }) => {
      const branch: z.core.JSONSchema.BaseSchema = {
        type: 'object',
        properties: { model: { type: 'string' } },
        ...(required ? { required: ['model'] } : {}),
      };
      const schema = {
        type: 'object',
        ...(composition === '$ref'
          ? { $defs: { branch }, $ref: '#/$defs/branch' }
          : { [composition]: [branch] }),
      };
      const registration = processProviderRegistration(
        providerPluginDescriptorSchema.parse({
          ...descriptor,
          config: {
            install: schema,
            run: schema,
            snapshot: schema,
            ...(stripUnknownKeys ? { stripUnknownKeys: true } : {}),
          },
        }),
        argv
      );
      for (const scope of ['install', 'run', 'snapshot'] as const) {
        expect(registration.parseConfig({ model: 'openai/gpt' }, scope)).toEqual({
          model: 'openai/gpt',
        });
        if (!required) expect(registration.parseConfig({}, scope)).toEqual({});
        expect(registration.parseConfig({ model: 'openai/gpt', unknown: true }, scope)).toEqual(
          stripUnknownKeys || scope === 'snapshot'
            ? { model: 'openai/gpt' }
            : { model: 'openai/gpt', unknown: true }
        );
      }
    }
  );

  test.each([{ type: undefined }, { type: ['object', 'null'] }, { type: 'object' }])(
    'object-applicable type $type normalizes run config and credential lookup alike',
    ({ type }) => {
      const model = z.toJSONSchema(normalizedConfigString(z.string(), 'slash-separated'), {
        io: 'input',
      });
      const registration = modelLookupRegistration({
        ...(type === undefined ? {} : { type }),
        properties: { model },
      });
      expect(registration.parseConfig({ model: ' openai / gpt ' }, 'run')).toEqual({
        model: 'openai/gpt',
      });
      expect(registration.credentials.vendorFor(' openai / gpt ')).toBe('openai');
    }
  );

  test('matching pattern normalizes an explicitly declared model in both registration paths', () => {
    const registration = modelLookupRegistration({
      type: 'object',
      properties: { model: { type: 'string' } },
      patternProperties: {
        '^model$': z.toJSONSchema(normalizedConfigString(z.string(), 'slash-separated'), {
          io: 'input',
        }),
      },
    });
    expect(registration.parseConfig({ model: ' openai / gpt ' }, 'run')).toEqual({
      model: 'openai/gpt',
    });
    expect(registration.credentials.vendorFor(' openai / gpt ')).toBe('openai');
  });

  test.each([
    'property',
    'pattern',
    'additional',
    'items',
    'tuple',
    '$ref',
    'allOf',
    'anyOf',
    'oneOf',
  ] as const)('unconstrained object data survives %s recursive projection', route => {
    const value = { arbitrary: 'kept', nested: { enabled: true } };
    const wrappers: Record<typeof route, z.core.JSONSchema.BaseSchema> = {
      property: { properties: { value: {} } },
      pattern: { patternProperties: { '^value$': {} } },
      additional: { additionalProperties: {} },
      items: { properties: { value: { type: 'array', items: {} } } },
      tuple: { properties: { value: { type: 'array', prefixItems: [{}] } } },
      $ref: { $defs: { value: {} }, properties: { value: { $ref: '#/$defs/value' } } },
      allOf: { properties: { value: { allOf: [{}] } } },
      anyOf: { properties: { value: { anyOf: [{}] } } },
      oneOf: { properties: { value: { oneOf: [{}] } } },
    };
    const schema = { type: 'object', ...wrappers[route] };
    const registration = processProviderRegistration(
      providerPluginDescriptorSchema.parse({
        ...descriptor,
        config: { install: schema, run: schema, snapshot: schema, stripUnknownKeys: true },
      }),
      argv
    );
    const raw = { value: route === 'items' || route === 'tuple' ? [value] : value };
    for (const scope of ['install', 'run', 'snapshot'] as const)
      expect(registration.parseConfig(raw, scope)).toEqual(raw);
  });

  test.each(['anyOf', 'oneOf'] as const)(
    '%s projection retains only the selected alternative plus enclosing and conjunct fields',
    keyword => {
      const choice = {
        [keyword]: [
          {
            type: 'object',
            properties: { kind: { const: 'left' }, left: { type: 'string' } },
            required: ['left'],
          },
          {
            type: 'object',
            properties: { kind: { const: 'right' }, right: { type: 'string' } },
            required: ['right'],
          },
        ],
      };
      for (const nested of [false, true]) {
        const selected = {
          type: 'object',
          properties: { shared: { type: 'string' } },
          allOf: [choice, { properties: { conjunct: { type: 'string' } } }],
        };
        const schema = nested ? { type: 'object', properties: { choice: selected } } : selected;
        const registration = processProviderRegistration(
          providerPluginDescriptorSchema.parse({
            ...descriptor,
            config: { install: schema, run: schema, snapshot: schema, stripUnknownKeys: true },
          }),
          argv
        );
        assertSelectedProjection(registration, nested);
      }
    }
  );

  test('generated union projection agrees with its Zod owner when both alternatives have fields', () => {
    const owner = z.object({
      choice: z.union([z.object({ left: z.string() }), z.object({ right: z.string() })]),
      value: z.unknown(),
    });
    const schema = z.toJSONSchema(owner, { io: 'input' });
    const registration = processProviderRegistration(
      providerPluginDescriptorSchema.parse({
        ...descriptor,
        config: { install: schema, run: schema, snapshot: schema, stripUnknownKeys: true },
      }),
      argv
    );
    for (const choice of [{ left: 'left', right: 'right' }, { right: 'right' }]) {
      const raw = { choice, value: { arbitrary: 'kept' } };
      for (const scope of ['install', 'run', 'snapshot'] as const)
        expect(registration.parseConfig(raw, scope)).toEqual(owner.parse(raw));
    }
  });
}
