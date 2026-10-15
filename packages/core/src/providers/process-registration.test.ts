import { prepareRunAiConfiguration, assertRunCredentials } from '@archon/workflows/run-preflight';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import { expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { providerPluginDescriptorSchema } from '@archon/provider-contract/plugin';
import { InvalidProviderRunConfigError, normalizedConfigString } from '@archon/provider-contract';
import { processProviderRegistration } from './process-registration';
import { claudeDescriptor, codexDescriptor, piDescriptor } from '@archon/providers';
import { parseClaudeConfigStrict } from '@archon/providers/claude/config';
import { parseCodexConfigStrict } from '@archon/providers/codex/config';
import { parsePiConfigStrict } from '@archon/providers/pi/config';
import { descriptor, parseConfig } from './fixtures/process-provider-data';
const argv = [process.execPath, 'fixture.ts'] as const;

test('session fork requires resume at descriptor conversion', () => {
  const input = {
    ...descriptor,
    capabilities: { ...descriptor.capabilities, sessionFork: true, sessionResume: false },
  };
  expect(() => processProviderRegistration(input, argv)).toThrow(
    `Provider plugin ${descriptor.id}: sessionFork requires sessionResume`
  );
  input.capabilities.sessionResume = true;
  expect(processProviderRegistration(input, argv).capabilities.sessionFork).toBe(true);
});

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

test.each(['scoped', 'legacy'] as const)(
  '%s plugin vendor lookup needs only the model field',
  route => {
    const run = z.strictObject({
      region: z.string(),
      model: normalizedConfigString(
        z.string().regex(/^\s*[a-z]+\s*\//),
        'slash-separated'
      ).optional(),
    });
    const registration = processProviderRegistration(
      providerPluginDescriptorSchema.parse({
        ...descriptor,
        id: 'stub-plugin',
        credentials: {
          kind: 'static',
          specs: [
            { vendor: 'acme', displayName: 'Acme', kinds: ['subscription'] },
            { vendor: 'openai', displayName: 'OpenAI', kinds: ['api_key'] },
          ],
        },
        configSchema: z.toJSONSchema(run, { io: 'input' }),
        config:
          route === 'scoped'
            ? {
                install: z.toJSONSchema(run, { io: 'input' }),
                run: z.toJSONSchema(run, { io: 'input' }),
                snapshot: z.toJSONSchema(run, { io: 'input' }),
              }
            : undefined,
      }),
      argv
    );
    expect(registration.parseConfig({ model: 'openai/gpt', region: 'eu' }, 'run')).toEqual({
      model: 'openai/gpt',
      region: 'eu',
    });
    expect(registration.credentials.vendorFor(' acme / m ')).toBe('acme');
    expect(registration.credentials.vendorFor('openai/gpt')).toBe('openai');
    expect(registration.credentials.vendorFor('Acme/m')).toBeUndefined();
    expect(registration.credentials.vendorFor(undefined)).toBeUndefined();
  }
);

test.each(['direct', 'field-ref', '$ref', 'intermediate-ref', 'allOf', 'anyOf', 'oneOf'] as const)(
  '%s plugin model rules normalize credential preflight without unrelated run fields',
  async composition => {
    const modelRule = normalizedConfigString(
      z.string().regex(/^\s*openai\s*\//),
      'slash-separated'
    );
    const fields = z.toJSONSchema(z.strictObject({ model: modelRule, region: z.literal('eu') }), {
      io: 'input',
    });
    const alternative = z.toJSONSchema(
      z.strictObject({ model: modelRule, region: z.literal('us') }),
      { io: 'input' }
    );
    const run =
      composition === 'direct'
        ? fields
        : composition === 'field-ref'
          ? {
              ...fields,
              $defs: { model: fields.properties?.model ?? true },
              properties: { ...fields.properties, model: { $ref: '#/$defs/model' } },
            }
          : composition === '$ref' || composition === 'intermediate-ref'
            ? {
                $defs: { fields, intermediate: { $ref: '#/$defs/fields' } },
                $ref: composition === '$ref' ? '#/$defs/fields' : '#/$defs/intermediate',
              }
            : { [composition]: composition === 'allOf' ? [fields] : [fields, alternative] };
    const registration = processProviderRegistration(
      providerPluginDescriptorSchema.parse({
        ...descriptor,
        config: { install: run, run, snapshot: run },
        credentials: {
          kind: 'static',
          specs: [
            { vendor: 'openai', displayName: 'OpenAI', kinds: ['api_key'] },
            { vendor: 'anthropic', displayName: 'Anthropic', kinds: ['api_key'] },
          ],
        },
      }),
      argv
    );
    const model = ' openai / gpt ';
    expect(registration.parseConfig({ model, region: 'eu' }, 'run')).toEqual({
      model: 'openai/gpt',
      region: 'eu',
    });
    expect(() => registration.parseConfig({ model: 'anthropic/gpt', region: 'eu' }, 'run')).toThrow(
      InvalidProviderRunConfigError
    );
    expect(registration.credentials.vendorFor('anthropic/gpt')).toBeUndefined();
    expect(registration.credentials.vendorFor(model)).toBe('openai');
    expect(registration.credentials.vendorFor('invalid')).toBeUndefined();
    const checkCredential = mock(async () => ({
      state: 'usable' as const,
      source: 'native' as const,
    }));
    const native = registration.factory();
    native.checkCredential = checkCredential;
    const getUserProviderCredentialStatus = mock(async (_user: string, _vendor: string) => ({
      kind: 'api_key' as const,
      status: { state: 'usable' as const, source: 'archon' as const },
    }));
    const deps = {
      providers: { get: () => registration, list: () => [registration] },
      loadConfig: async () => ({
        assistant: registration.id,
        assistants: { claude: {}, codex: {}, [registration.id]: { model, region: 'eu' } },
        commands: {},
      }),
      store: { getCodebaseEnvVars: async () => ({}) },
      getAgentProvider: () => native,
      isPerUserProviderKeysEnabled: () => true,
      getUserProviderCredentialStatus,
    };
    const prepared = await prepareRunAiConfiguration(
      deps,
      makeTestResolvedWorkflow({ name: 'plugin-credentials' }),
      '/project',
      { userId: 'user' }
    );
    expect(prepared.requirements).toEqual([
      { provider: registration.id, model: 'openai/gpt', vendor: 'openai' },
    ]);
    await assertRunCredentials(deps, {
      ...prepared,
      requirements: [
        { provider: registration.id, model, vendor: registration.credentials.vendorFor(model) },
      ],
    });
    expect(getUserProviderCredentialStatus).toHaveBeenCalledWith('user', 'openai');
    expect(checkCredential).not.toHaveBeenCalled();
  }
);

test.each(
  (['$ref', 'allOf', 'anyOf', 'oneOf'] as const).flatMap(composition =>
    [false, true].map(constrainBranchModel => ({ composition, constrainBranchModel }))
  )
)(
  '$composition siblings preserve root model rules (branch model constraint: $constrainBranchModel)',
  ({ composition, constrainBranchModel }) => {
    const root = z.toJSONSchema(
      z.object({
        model: normalizedConfigString(z.string().regex(/^\s*openai\s*\//), 'slash-separated'),
      }),
      { io: 'input' }
    );
    const region: z.core.JSONSchema.BaseSchema = {
      type: 'object',
      properties: {
        region: { const: 'eu' },
        ...(constrainBranchModel
          ? { model: { type: 'string', pattern: '^\\s*[a-z]+\\s*/\\s*gpt\\s*$' } }
          : {}),
      },
      required: ['region'],
    };
    const run = {
      ...root,
      ...(composition === '$ref'
        ? { $defs: { region }, $ref: '#/$defs/region' }
        : { [composition]: [region] }),
    };
    const registration = processProviderRegistration(
      providerPluginDescriptorSchema.parse({
        ...descriptor,
        config: { install: run, run, snapshot: run },
        credentials: {
          kind: 'static',
          specs: [
            { vendor: 'openai', displayName: 'OpenAI', kinds: ['api_key'] },
            { vendor: 'anthropic', displayName: 'Anthropic', kinds: ['api_key'] },
          ],
        },
      }),
      argv
    );
    expect(z.fromJSONSchema(run).safeParse({ model: ' openai / gpt ', region: 'eu' }).success).toBe(
      true
    );
    expect(registration.parseConfig({ model: ' openai / gpt ', region: 'eu' }, 'run')).toEqual({
      model: 'openai/gpt',
      region: 'eu',
    });
    expect(registration.credentials.vendorFor(' openai / gpt ')).toBe('openai');
    expect(registration.credentials.vendorFor('anthropic/gpt')).toBeUndefined();
    expect(registration.credentials.vendorFor('openai/other')).toBe(
      constrainBranchModel ? undefined : 'openai'
    );
  }
);

test('oneOf credential lookup accepts a distinct second model branch', () => {
  const branch = (vendor: string, region: string) =>
    z.toJSONSchema(
      z.strictObject({
        model: normalizedConfigString(
          z.string().regex(new RegExp(`^\\s*${vendor}\\s*\\/`)),
          'slash-separated'
        ),
        region: z.literal(region),
      }),
      { io: 'input' }
    );
  const run = { oneOf: [branch('openai', 'eu'), branch('anthropic', 'us')] };
  const registration = processProviderRegistration(
    providerPluginDescriptorSchema.parse({
      ...descriptor,
      config: { install: run, run, snapshot: run },
      credentials: {
        kind: 'static',
        specs: [
          { vendor: 'openai', displayName: 'OpenAI', kinds: ['api_key'] },
          { vendor: 'anthropic', displayName: 'Anthropic', kinds: ['api_key'] },
        ],
      },
    }),
    argv
  );
  for (const [vendor, model, region] of [
    ['openai', ' openai / gpt ', 'eu'],
    ['anthropic', ' anthropic / sonnet ', 'us'],
  ]) {
    expect(registration.parseConfig({ model, region }, 'run')).toEqual({
      model: `${vendor}/${vendor === 'openai' ? 'gpt' : 'sonnet'}`,
      region,
    });
    expect(registration.credentials.vendorFor(model)).toBe(vendor);
  }
});

function modelLookupRegistration(run: z.core.JSONSchema.BaseSchema) {
  return processProviderRegistration(
    providerPluginDescriptorSchema.parse({
      ...descriptor,
      config: { install: run, run, snapshot: run },
      credentials: {
        kind: 'static',
        specs: [
          { vendor: 'openai', displayName: 'OpenAI', kinds: ['api_key'] },
          { vendor: 'anthropic', displayName: 'Anthropic', kinds: ['api_key'] },
        ],
      },
    }),
    argv
  );
}

const objectModelRules: z.core.JSONSchema.BaseSchema[] = [
  { patternProperties: { '^model$': { type: 'string', pattern: '^openai/' } } },
  {
    properties: { model: { type: 'string' } },
    patternProperties: { '^model$': { type: 'string', pattern: '^openai/' } },
  },
  {
    patternProperties: {
      '^model': { type: 'string', pattern: '^(openai|anthropic)/' },
      model$: { type: 'string', pattern: '^openai/' },
    },
  },
  { additionalProperties: { type: 'string', pattern: '^openai/' } },
  { additionalProperties: false },
];

test.each(objectModelRules)(
  'credential lookup applies every object rule covering model: %j',
  rules => {
    const registration = modelLookupRegistration({ type: 'object', ...rules });
    expect(() => registration.parseConfig({ model: 'anthropic/gpt' }, 'run')).toThrow(
      InvalidProviderRunConfigError
    );
    expect(registration.credentials.vendorFor('anthropic/gpt')).toBeUndefined();
    if (rules.additionalProperties !== false) {
      expect(registration.parseConfig({ model: 'openai/gpt' }, 'run')).toEqual({
        model: 'openai/gpt',
      });
      expect(registration.credentials.vendorFor('openai/gpt')).toBe('openai');
    }
  }
);

test.each(['anyOf', 'oneOf'] as const)(
  '%s credential lookup rejects ambiguous model normalization',
  composition => {
    const run = {
      [composition]: [
        z.toJSONSchema(z.object({ region: z.literal('us'), model: z.string() }), { io: 'input' }),
        z.toJSONSchema(
          z.object({
            region: z.literal('eu'),
            model: normalizedConfigString(z.string(), 'slash-separated'),
          }),
          { io: 'input' }
        ),
      ],
    };
    const registration = modelLookupRegistration(run);
    expect(registration.parseConfig({ model: 'openai/gpt ', region: 'eu' }, 'run')).toEqual({
      model: 'openai/gpt',
      region: 'eu',
    });
    expect(registration.credentials.vendorFor('openai/gpt ')).toBeUndefined();
    expect(registration.credentials.vendorFor('openai/gpt')).toBe('openai');
  }
);

test('a declared skillDiscovery survives process registration', () => {
  const skillDiscovery = { project: ['.stub/skills'], user: ['skills'] };
  expect(
    processProviderRegistration({ ...descriptor, skillDiscovery }, argv).skillDiscovery
  ).toEqual(skillDiscovery);
  expect(processProviderRegistration(descriptor, argv)).not.toHaveProperty('skillDiscovery');
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

test('descriptors without scoped config validate all scopes with configSchema', () => {
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

test('process Pi credential selection normalizes every declared vendor model', () => {
  const registration = processProviderRegistration(piDescriptor, argv);
  for (const spec of piDescriptor.credentials.specs) {
    expect(registration.credentials.vendorFor(`  ${spec.vendor} / model/name  `)).toBe(spec.vendor);
  }
  expect(registration.credentials.vendorFor(' malformed ')).toBeUndefined();
});

test('whitespace Pi models preflight the stored vendor credential instead of native auth', async () => {
  const registration = processProviderRegistration(piDescriptor, argv);
  const native = registration.factory();
  const checkCredential = mock(native.checkCredential.bind(native));
  native.checkCredential = checkCredential;
  const getUserProviderCredentialStatus = mock(async (_user: string, _vendor: string) => ({
    kind: 'api_key' as const,
    status: { state: 'usable' as const, source: 'archon' as const },
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
    getUserProviderCredentialStatus,
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
  await assertRunCredentials(deps, {
    ...prepared,
    requirements: [{ provider: 'pi', model, vendor: registration.credentials.vendorFor(model) }],
  });
  expect(getUserProviderCredentialStatus).toHaveBeenCalledWith('user', 'google');
  expect(checkCredential).not.toHaveBeenCalled();
});
