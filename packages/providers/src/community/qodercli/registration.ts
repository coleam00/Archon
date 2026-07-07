import { isRegisteredProvider, registerProvider } from '../../registry';

import { QODERCLI_CAPABILITIES } from './capabilities';
import { QoderCliProvider } from './provider';

/**
 * Register the Qoder CLI community provider.
 *
 * Authentication remains owned by `qodercli login`; Archon does not store Qoder credentials in v1.
 */
export function registerQoderCliProvider(): void {
  if (isRegisteredProvider('qodercli')) return;
  registerProvider({
    id: 'qodercli',
    displayName: 'Qoder CLI',
    factory: () => new QoderCliProvider(),
    capabilities: QODERCLI_CAPABILITIES,
    builtIn: false,
    credentials: { kind: 'static', specs: [] },
  });
}
