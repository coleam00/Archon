/**
 * GitHub Copilot CLI community provider — barrel export.
 *
 * Re-exports all public surfaces of the Copilot provider for consumers
 * that use the `@archon/providers/community/copilot` package export path.
 */
export { COPILOT_CAPABILITIES } from './capabilities';
export { parseCopilotConfig } from './config';
export type { CopilotProviderDefaults } from './config';
export { buildCopilotArgs } from './args';
export type { BuildCopilotArgsOptions } from './args';
export { resolveCopilotBinaryPath, fileExists as copilotFileExists } from './binary-resolver';
export { CopilotProvider } from './provider';
export { registerCopilotProvider } from './registration';
