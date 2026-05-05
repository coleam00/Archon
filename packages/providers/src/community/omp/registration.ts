import { isRegisteredProvider, registerProvider } from '../../registry';

import { OMP_CAPABILITIES } from './capabilities';
import { OmpProvider } from './provider';

/** Register the Oh My Pi community provider. Idempotent. */
export function registerOmpProvider(): void {
  if (isRegisteredProvider('omp')) return;
  registerProvider({
    id: 'omp',
    displayName: 'Oh My Pi (community)',
    factory: () => new OmpProvider(),
    capabilities: OMP_CAPABILITIES,
    builtIn: false,
  });
}
