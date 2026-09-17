import { isRegisteredProvider, registerProvider } from '../../registry';
import { GROK_CAPABILITIES } from './capabilities';
import { parseGrokRunConfig } from './config';
import { GrokProvider } from './provider';

export function registerGrokProvider(): void {
  if (isRegisteredProvider('grok')) return;
  registerProvider({
    id: 'grok',
    displayName: 'Grok (xAI)',
    factory: () => new GrokProvider(),
    capabilities: GROK_CAPABILITIES,
    builtIn: false,
    parseRunConfig: parseGrokRunConfig,
    credentials: {
      kind: 'static',
      specs: [
        {
          vendor: 'xai',
          displayName: 'xAI',
          kinds: ['subscription'],
        },
      ],
    },
  });
}
