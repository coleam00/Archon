export { ClaudeProvider } from './provider';
export { parseClaudeConfig, type ClaudeProviderDefaults } from './config';
export { loadMcpConfig } from '../mcp/config';
export { withFirstMessageTimeout, getProcessUid } from './provider';
export { buildSDKHooksFromYAML } from './node-config';
import { ClaudeProvider } from './provider';
export { descriptor } from './descriptor';
export function createProvider(
  ...args: ConstructorParameters<typeof ClaudeProvider>
): ClaudeProvider {
  return new ClaudeProvider(...args);
}
