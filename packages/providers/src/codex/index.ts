export { CodexProvider } from './provider';
export { parseCodexConfig, type CodexProviderDefaults } from './config';
export { resolveCodexBinaryPath, fileExists } from './binary-resolver';
import { CodexProvider } from './provider';
export { descriptor } from './descriptor';
export function createProvider(
  ...args: ConstructorParameters<typeof CodexProvider>
): CodexProvider {
  return new CodexProvider(...args);
}
