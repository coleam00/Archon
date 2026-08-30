/**
 * Public surface for the GitHub auth module (OAuth App mode).
 */
export { installCredentialHelper } from './credential-helper-install';

// Per-user device flow
export { isPerUserGitHubEnabled, loadDeviceFlowConfig, assertEncryptionKeyAtBoot } from './config';
export type { DeviceFlowConfig } from './config';
export { connectGithubForUser, persistGithubConnection } from './connect-service';
export type { ConnectGithubResult, ConnectGithubOptions } from './connect-service';
export {
  startDeviceFlow,
  pollDeviceFlow,
  pollDeviceFlowOnce,
  refreshUserToken,
  fetchGithubUser,
  DeviceFlowError,
} from './device-flow';
export type {
  DeviceCodeResponse,
  DeviceAccessToken,
  GithubUserProfile,
  PollOnceResult,
} from './device-flow';
