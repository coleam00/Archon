import { isRegisteredProvider, registerProvider } from '../../registry';

import { HERMES_CAPABILITIES } from './capabilities';
import { HermesProvider } from './provider';

export function registerHermesProvider(): void {
  if (isRegisteredProvider('hermes')) return;
  registerProvider({
    id: 'hermes',
    displayName: 'Hermes (community)',
    factory: () => new HermesProvider(),
    capabilities: HERMES_CAPABILITIES,
    builtIn: false,
  });
}
