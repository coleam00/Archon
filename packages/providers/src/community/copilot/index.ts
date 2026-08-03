export { COPILOT_CAPABILITIES } from './capabilities';
export { parseCopilotConfig, type CopilotProviderDefaults } from './config';
export { resolveCopilotBinaryPath, fileExists } from './binary-resolver';
export { CopilotProvider, resetCopilotSingleton } from './provider';
export { registerCopilotProvider } from './registration';
