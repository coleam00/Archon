import { z } from 'zod';
import { BUNDLED_VERSION } from '@archon/paths';
import { providerPluginDescriptorSchema } from '@archon/provider-contract/plugin/wire';
import { PI_CAPABILITIES } from './capabilities';
import { configSchemas } from './config';
import { PI_CREDENTIAL_SPECS } from './pi-vendor-map.generated';

export const descriptor = providerPluginDescriptorSchema.parse({
  protocol: 1,
  id: 'pi',
  displayName: 'Pi',
  version: BUNDLED_VERSION,
  capabilities: PI_CAPABILITIES,
  credentials: { kind: 'static', specs: PI_CREDENTIAL_SPECS },
  configSchema: z.toJSONSchema(configSchemas.install, { io: 'input' }),
  config: {
    install: z.toJSONSchema(configSchemas.install, { io: 'input' }),
    run: z.toJSONSchema(configSchemas.run, { io: 'input' }),
    snapshot: z.toJSONSchema(configSchemas.snapshot, { io: 'input' }),
    stripUnknownKeys: true,
  },
  ownsUnprefixedModelRefs: true,
});
