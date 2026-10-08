// Contract types owned by @archon/provider-contract, re-exported for existing consumers
export type {
  IAgentProvider,
  SendQueryOptions,
  ProviderDefaultsMap,
  ProviderCapabilities,
  ProviderRegistration,
  ProviderInfo,
  MessageChunk,
  TokenUsage,
  CredentialKind,
  ProviderAdmissionEvent,
} from './types';
export { CREDENTIAL_KINDS } from './types';

// Registry
export {
  assertProviderRegistrationAllowed,
  registerProvider,
  markProviderUnavailable,
  getAgentProvider,
  getRegistration,
  getProviderCapabilities,
  parseProviderRunModel,
  getRegisteredProviders,
  getProviderInfoList,
  isRegisteredProvider,
  clearRegistry,
  providerRegistry,
} from './registry';

// Error
export { InvalidProviderRunConfigError } from '@archon/provider-contract';

// Generated Pi backend → env-var map + ambient vendors (single source for the
// Pi runtime bridge and @archon/core's credential delivery — see #1955).
export { PI_PROVIDER_ENV_VARS, PI_AMBIENT_VENDORS } from './community/pi/pi-vendor-map.generated';

export { DEPRECATED_PROVIDERS_DOCS_PATH } from './community/deprecation';

export {
  singleVendorCatalog,
  normalizeCredentialVendor,
  LEGACY_VENDOR_ALIASES,
} from './credential-catalog';

export { descriptor as claudeDescriptor } from './claude/descriptor';
export { descriptor as codexDescriptor } from './codex/descriptor';
export { descriptor as piDescriptor } from './community/pi/descriptor';
export type {
  ClaudeProviderDefaults,
  CodexProviderDefaults,
  PiProviderDefaults,
  OpencodeProviderDefaults,
  CopilotProviderDefaults,
} from './types';
export type { PiModelInfo } from './community/pi/model-catalog';
export type {
  OpencodeCredentialIntrospection,
  OpencodeCredentialProvider,
  OpencodeAuthMethod,
} from './community/opencode';
