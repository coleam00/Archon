import { normalizeCredentialVendor } from '../../credential-catalog';
import { parsePiModelRef } from './model-ref';
import { isRegisteredProvider, registerProvider } from '../../registry';

import { descriptor } from './descriptor';
import { createProvider } from './index';
import { parsePiConfigStrict } from './config';
const PI_CREDENTIAL_SPECS = descriptor.credentials.specs;

export function registerPiProvider(): void {
  if (isRegisteredProvider('pi')) return;
  registerProvider({
    id: descriptor.id,
    ownsUnprefixedModelRefs: descriptor.ownsUnprefixedModelRefs,
    displayName: descriptor.displayName,
    factory: createProvider,
    capabilities: descriptor.capabilities,
    builtIn: true,
    parseConfig: parsePiConfigStrict,
    // Generated from the installed pi-ai SDK — see generate:pi-vendor-map.
    credentials: {
      kind: 'static',
      specs: PI_CREDENTIAL_SPECS,
      vendorFor: model => {
        const provider = model === undefined ? undefined : parsePiModelRef(model)?.provider;
        if (!provider) return undefined;
        const vendor = normalizeCredentialVendor(provider);
        return PI_CREDENTIAL_SPECS.some(spec => spec.vendor === vendor) ? vendor : undefined;
      },
    },
  });
}
