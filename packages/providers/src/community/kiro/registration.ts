import { isRegisteredProvider, registerProvider } from '../../registry';

import { KIRO_CAPABILITIES } from './capabilities';
import { KiroProvider } from './provider';

export function registerKiroProvider(): void {
  if (isRegisteredProvider('kiro')) return;
  registerProvider({
    id: 'kiro',
    displayName: 'Kiro CLI',
    factory: () => new KiroProvider(),
    capabilities: KIRO_CAPABILITIES,
    builtIn: false,
  });
}
