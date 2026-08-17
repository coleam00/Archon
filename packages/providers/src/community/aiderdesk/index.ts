export { AIDERDESK_CAPABILITIES } from './capabilities';
export {
  parseAiderdeskConfig,
  type AiderDeskProviderDefaults,
  type ParsedAiderdeskConfig,
} from './config';
export { AiderDeskClient, resolveDefaultApiUrl, type FetchFn } from './client';
export {
  AiderDeskApiError,
  classifyAiderdeskError,
  enrichAiderdeskError,
  errorMessage,
  InvalidAiderDeskModelOverrideError,
  UnknownAiderDeskAgentProfileError,
  type AiderDeskRetryableErrorClass,
} from './errors';
export { listAiderdeskModels } from './model-catalog';
export { levenshtein, nearestNames } from './profile-matcher';
export { AiderDeskProvider } from './provider';
export { registerAiderdeskProvider } from './registration';
export {
  type AiderDeskTask,
  type AiderDeskTaskFull,
  type AiderDeskTaskState,
  type AiderDeskMessage,
  type AiderDeskModel,
  type AiderDeskModelInfo,
  type AiderDeskRunMode,
  type AiderDeskContextFile,
  TERMINAL_TASK_STATES,
} from './types';
