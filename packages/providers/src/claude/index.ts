export { ClaudeProvider } from './provider';
export { parseClaudeConfig, type ClaudeProviderDefaults } from './config';
export { loadMcpConfig } from '../mcp/config';
export { buildSDKHooksFromYAML, withFirstMessageTimeout, getProcessUid } from './provider';
import { ClaudeProvider } from './provider';
export { descriptor } from './descriptor';
export function createProvider(
  ...args: ConstructorParameters<typeof ClaudeProvider>
): ClaudeProvider {
  return new ClaudeProvider(...args);
}
