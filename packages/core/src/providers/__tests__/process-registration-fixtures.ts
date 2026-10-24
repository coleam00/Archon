import { expect } from 'bun:test';
import { z } from 'zod';
import { providerPluginDescriptorSchema } from '@archon/provider-contract/plugin';
import { processProviderRegistration } from '../process-registration';
import { descriptor } from '../fixtures/process-provider-data';

export const argv = [process.execPath, 'fixture.ts'] as const;

export function modelLookupRegistration(run: unknown) {
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

export const objectModelRules: z.core.JSONSchema.BaseSchema[] = [
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

export function assertSelectedProjection(
  registration: ReturnType<typeof processProviderRegistration>,
  nested: boolean
): void {
  for (const kind of ['left', 'right']) {
    const fields = {
      kind,
      left: 'left',
      right: 'right',
      shared: 'shared',
      conjunct: 'conjunct',
      unknown: true,
    };
    const expected = { kind, [kind]: kind, shared: 'shared', conjunct: 'conjunct' };
    for (const scope of ['install', 'run', 'snapshot'] as const)
      expect(registration.parseConfig(nested ? { choice: fields } : fields, scope)).toEqual(
        nested ? { choice: expected } : expected
      );
  }
}
