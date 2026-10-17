import { normalizeCredentialVendor } from '@archon/providers';
import { z } from 'zod';
import {
  InvalidProviderRunConfigError,
  isMaintainedProvider,
  hasValidProviderCapabilities,
  type ProviderRegistration,
  type ProviderDefaults,
} from '@archon/provider-contract';
import {
  providerPluginDescriptorSchema,
  type ProviderPluginDescriptor,
} from '@archon/provider-contract/plugin';
import { KNOWN_VENDORS } from '../credentials/delivery';
import { ProcessAgentProvider, type ProcessProviderOrigin } from './process-provider';
import { modelConfigSchema, scopedConfigSchema } from './scoped-config';

export function processProviderRegistration(
  input: ProviderPluginDescriptor,
  argv: readonly [string, ...string[]],
  origin: ProcessProviderOrigin = 'installed'
): ProviderRegistration {
  const descriptor = providerPluginDescriptorSchema.parse(input);
  if (!hasValidProviderCapabilities(descriptor.capabilities)) {
    throw new Error(`Provider plugin ${descriptor.id}: sessionFork requires sessionResume`);
  }
  for (const spec of descriptor.credentials.specs) {
    if (spec.kinds.includes('api_key') && !KNOWN_VENDORS.has(spec.vendor)) {
      throw new Error(
        `Provider plugin ${descriptor.id}: no credential delivery rule for ${spec.vendor}`
      );
    }
  }
  const config = descriptor.config;
  const legacySchema = z.fromJSONSchema(descriptor.configSchema);
  const schemas = config
    ? {
        install: scopedConfigSchema(config.install, config.stripUnknownKeys === true, false),
        run: scopedConfigSchema(config.run, config.stripUnknownKeys === true, false),
        snapshot: scopedConfigSchema(config.snapshot, config.stripUnknownKeys === true, true),
      }
    : { install: legacySchema, run: legacySchema, snapshot: legacySchema };
  const specs = descriptor.credentials.specs;
  const runSchema: z.core.JSONSchema.BaseSchema = config?.run ?? descriptor.configSchema;
  const runModel = modelConfigSchema(runSchema);
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    capabilities: descriptor.capabilities,
    builtIn: isMaintainedProvider(descriptor.id),
    ...(descriptor.ownsUnprefixedModelRefs ? { ownsUnprefixedModelRefs: true } : {}),
    ...(descriptor.skillDiscovery ? { skillDiscovery: descriptor.skillDiscovery } : {}),
    credentials: {
      ...descriptor.credentials,
      // Vendor lookup receives only a model, so unrelated required run settings
      // must not prevent validation and normalization of the model field.
      vendorFor(model): string | undefined {
        if (specs.length === 1) return specs[0].vendor;
        if (model === undefined) return undefined;
        const parsed = runModel.safeParse({ model });
        if (!parsed.success) return undefined;
        const prefix = normalizeCredentialVendor(parsed.data.model.split('/')[0]);
        return specs.find(spec => spec.vendor === prefix)?.vendor;
      },
    },
    parseConfig(raw, scope): ProviderDefaults {
      const parsed = schemas[scope].safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new InvalidProviderRunConfigError(
          [...issue.path, ...(issue.code === 'unrecognized_keys' ? [issue.keys[0]] : [])].join('.'),
          issue.message
        );
      }
      return z.record(z.string(), z.unknown()).parse(parsed.data);
    },
    factory: () => new ProcessAgentProvider(descriptor, argv, origin),
  };
}
