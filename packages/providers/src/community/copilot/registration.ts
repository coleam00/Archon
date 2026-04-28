import { isRegisteredProvider, registerProvider } from '../../registry';
import { COPILOT_CAPABILITIES } from './capabilities';
import { CopilotProvider } from './provider';

export function isCopilotModelCompatible(model: string): boolean {
  const normalized = model.trim();
  return normalized.length > 0 && normalized !== 'inherit';
}

export function registerCopilotProvider(): void {
  if (isRegisteredProvider('copilot')) return;
  registerProvider({
    id: 'copilot',
    displayName: 'GitHub Copilot (community)',
    factory: () => new CopilotProvider(),
    capabilities: COPILOT_CAPABILITIES,
    isModelCompatible: isCopilotModelCompatible,
    builtIn: false,
  });
}
