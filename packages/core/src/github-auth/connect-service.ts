/**
 * Orchestrates the "connect GitHub" device flow for an existing Archon user.
 * Shared by the Web REST endpoints, the Slack slash command, and the CLI.
 *
 * Steps: start device flow → surface the code to the caller (onCode) → poll
 * until authorized → fetch the GitHub profile → bind the GitHub identity to the
 * existing user (conflict-guarded) → persist encrypted tokens → cache the
 * profile (display_name + email) on the users row.
 *
 * The identity bind runs BEFORE token persistence so a contested GitHub account
 * (already linked to another user) fails without leaving an orphan token row.
 */
import { createLogger } from '@archon/paths';
import { loadDeviceFlowConfig } from './config';
import {
  startDeviceFlow,
  pollDeviceFlow,
  fetchGithubUser,
  type DeviceCodeResponse,
} from './device-flow';
import { saveUserGithubToken } from '../db/user-github-token-store';
import { updateUserGithubProfile, linkGithubIdentity } from '../db/users';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('github-auth.connect');
  return cachedLog;
}

export interface ConnectGithubResult {
  githubLogin: string;
}

export interface ConnectGithubOptions {
  signal?: AbortSignal;
}

export async function connectGithubForUser(
  userId: string,
  onCode: (info: DeviceCodeResponse) => void | Promise<void>,
  opts: ConnectGithubOptions = {}
): Promise<ConnectGithubResult> {
  const { clientId } = loadDeviceFlowConfig();

  const device = await startDeviceFlow(clientId);
  await onCode(device);

  const token = await pollDeviceFlow(clientId, device.device_code, device.interval, {
    signal: opts.signal,
  });
  const profile = await fetchGithubUser(token.access_token);

  // Conflict guard first — throws GithubIdentityConflictError if this GitHub
  // account already belongs to a different Archon user.
  await linkGithubIdentity(userId, profile.login);

  const now = Date.now();
  await saveUserGithubToken({
    userId,
    githubUserId: profile.id,
    githubLogin: profile.login,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    accessTokenExpiresAt: token.expires_in ? new Date(now + token.expires_in * 1000) : null,
    refreshTokenExpiresAt: token.refresh_token_expires_in
      ? new Date(now + token.refresh_token_expires_in * 1000)
      : null,
  });
  await updateUserGithubProfile(userId, {
    display_name: profile.name ?? profile.login,
    email: profile.email,
  });

  getLog().info({ userId, githubLogin: profile.login }, 'github_connect.completed');
  return { githubLogin: profile.login };
}
