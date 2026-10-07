import { z } from 'zod';
import {
  InvalidProviderRunConfigError,
  type ProviderRegistration,
  type ProviderDefaults,
} from '@archon/provider-contract';
import {
  providerPluginDescriptorSchema,
  type ProviderPluginDescriptor,
} from '@archon/provider-contract/plugin';
import { KNOWN_VENDORS } from '../credentials/delivery';
import { ProcessAgentProvider } from './process-provider';

export function processProviderRegistration(
  input: ProviderPluginDescriptor,
  argv: readonly [string, ...string[]]
): ProviderRegistration {
  const descriptor = providerPluginDescriptorSchema.parse(input);
  if (descriptor.capabilities.sessionFork && !descriptor.capabilities.sessionResume) {
    throw new Error(`Provider plugin ${descriptor.id}: sessionFork requires sessionResume`);
  }
  for (const spec of descriptor.credentials.specs) {
    if (spec.kinds.includes('api_key') && !KNOWN_VENDORS.has(spec.vendor)) {
      throw new Error(
        `Provider plugin ${descriptor.id}: no credential delivery rule for ${spec.vendor}`
      );
    }
  }
  const schema = z.fromJSONSchema(descriptor.configSchema);
  const specs = descriptor.credentials.specs;
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    capabilities: descriptor.capabilities,
    builtIn: false,
    ...(descriptor.ownsUnprefixedModelRefs ? { ownsUnprefixedModelRefs: true } : {}),
    credentials: {
      ...descriptor.credentials,
      vendorFor(model): string | undefined {
        if (specs.length === 1) return specs[0].vendor;
        const prefix = model?.split('/')[0];
        return specs.find(spec => spec.vendor === prefix)?.vendor;
      },
    },
    parseConfig(raw): ProviderDefaults {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new InvalidProviderRunConfigError(
          [...issue.path, ...(issue.code === 'unrecognized_keys' ? [issue.keys[0]] : [])].join('.'),
          issue.message
        );
      }
      return z.record(z.string(), z.unknown()).parse(parsed.data);
    },
    factory: () => new ProcessAgentProvider(descriptor, argv),
  };
}
