import { z } from 'zod';
import { BUNDLED_VERSION } from '@archon/paths';
import { providerPluginDescriptorSchema } from '@archon/provider-contract/plugin/wire';
import { CODEX_CAPABILITIES } from './capabilities';
import { configSchemas } from './config';
import { singleVendorCatalog } from '../credential-catalog';

export const descriptor = providerPluginDescriptorSchema.parse({
  protocol: 1,
  id: 'codex',
  displayName: 'Codex (OpenAI)',
  version: BUNDLED_VERSION,
  capabilities: CODEX_CAPABILITIES,
  credentials: {
    kind: 'static',
    specs: singleVendorCatalog({
      vendor: 'openai',
      displayName: 'OpenAI',
      kinds: ['api_key', 'subscription'],
    }).specs,
  },
  configSchema: z.toJSONSchema(configSchemas.install, { io: 'input' }),
  config: {
    install: z.toJSONSchema(configSchemas.install, { io: 'input' }),
    run: z.toJSONSchema(configSchemas.run, { io: 'input' }),
    snapshot: z.toJSONSchema(configSchemas.snapshot, { io: 'input' }),
    stripUnknownKeys: true,
  },
});
