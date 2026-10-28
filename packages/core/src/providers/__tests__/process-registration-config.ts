import { assertRunCredentials, prepareRunAiConfiguration } from '@archon/workflows/run-preflight';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import { expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { providerPluginDescriptorSchema } from '@archon/provider-contract/plugin';
import { InvalidProviderRunConfigError, normalizedConfigString } from '@archon/provider-contract';
import { processProviderRegistration } from '../process-registration';
import { descriptor, parseConfig } from '../fixtures/process-provider-data';
import { argv, modelLookupRegistration, objectModelRules } from './process-registration-fixtures';
export function registerConfigTests() {
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

  test.each([
    'direct',
    'field-ref',
    '$ref',
    'intermediate-ref',
    'allOf',
    'anyOf',
    'oneOf',
    'object anyOf+oneOf',
    'field anyOf+oneOf',
  ] as const)(
    '%s plugin model rules normalize config and credential preflight without unrelated run fields',
    async shape => {
      const modelRule = z.toJSONSchema(
        normalizedConfigString(z.string().regex(/^\s*openai\s*\//), 'slash-separated'),
        { io: 'input' }
      );
      const fields = (region: string): z.core.JSONSchema.BaseSchema => ({
        type: 'object',
        properties: { model: modelRule, region: { const: region } },
        required: ['model', 'region'],
        additionalProperties: false,
      });
      const runs: Record<typeof shape, z.core.JSONSchema.BaseSchema> = {
        direct: fields('eu'),
        'field-ref': {
          ...fields('eu'),
          $defs: { model: modelRule },
          properties: { model: { $ref: '#/$defs/model' }, region: { const: 'eu' } },
        },
        $ref: { $defs: { fields: fields('eu') }, $ref: '#/$defs/fields' },
        'intermediate-ref': {
          $defs: { fields: fields('eu'), intermediate: { $ref: '#/$defs/fields' } },
          $ref: '#/$defs/intermediate',
        },
        allOf: { allOf: [fields('eu')] },
        anyOf: { anyOf: [fields('eu'), fields('us')] },
        oneOf: { oneOf: [fields('eu'), fields('us')] },
        // Both keywords apply: the model rule lives only in oneOf, the region only in anyOf.
        'object anyOf+oneOf': {
          type: 'object',
          anyOf: [
            { type: 'object', properties: { region: { const: 'eu' } }, required: ['region'] },
          ],
          oneOf: [{ type: 'object', properties: { model: modelRule }, required: ['model'] }],
        },
        'field anyOf+oneOf': {
          ...fields('eu'),
          properties: {
            model: { type: 'string', anyOf: [{ type: 'string' }], oneOf: [modelRule] },
            region: { const: 'eu' },
          },
        },
      };
      const run = runs[shape];
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
      for (const scope of ['install', 'run', 'snapshot'] as const)
        expect(registration.parseConfig({ model, region: 'eu' }, scope)).toEqual({
          model: 'openai/gpt',
          region: 'eu',
        });
      expect(() =>
        registration.parseConfig({ model: 'anthropic/gpt', region: 'eu' }, 'run')
      ).toThrow(InvalidProviderRunConfigError);
      expect(registration.credentials.vendorFor('anthropic/gpt')).toBeUndefined();
      expect(registration.credentials.vendorFor(model)).toBe('openai');
      expect(registration.credentials.vendorFor('invalid')).toBeUndefined();
      const checkCredential = mock(async () => ({
        state: 'usable' as const,
        source: 'native' as const,
      }));
      const native = registration.factory();
      native.checkCredential = checkCredential;
      const getUserProviderCredential = mock(async (_user: string, _vendor: string) => ({
        kind: 'api_key' as const,
        getStatus: async () => ({ state: 'usable' as const, source: 'archon' as const }),
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
        getUserProviderCredential,
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
      await assertRunCredentials(
        deps,
        {
          ...prepared,
          requirements: [
            { provider: registration.id, model, vendor: registration.credentials.vendorFor(model) },
          ],
        },
        { cwd: '/project' }
      );
      expect(getUserProviderCredential).toHaveBeenCalledWith('user', 'openai');
      expect(checkCredential).not.toHaveBeenCalled();
    }
  );

  test.each(
    (['$ref', 'allOf', 'anyOf', 'oneOf'] as const).flatMap(composition =>
      [false, true].flatMap(constrainBranchModel =>
        [false, true].map(stripUnknownKeys => ({
          composition,
          constrainBranchModel,
          stripUnknownKeys,
        }))
      )
    )
  )(
    '$composition siblings preserve root model rules (branch constraint: $constrainBranchModel, strip: $stripUnknownKeys)',
    ({ composition, constrainBranchModel, stripUnknownKeys }) => {
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
          config: {
            install: run,
            run,
            snapshot: run,
            ...(stripUnknownKeys ? { stripUnknownKeys: true } : {}),
          },
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
      expect(
        z.fromJSONSchema(run).safeParse({ model: ' openai / gpt ', region: 'eu' }).success
      ).toBe(true);
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
}
