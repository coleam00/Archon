import type { OmpCodingAgentSdk, OmpSessionManager } from './sdk-loader';

export interface ResolvedOmpSession {
  sessionManager: OmpSessionManager;
  resumeFailed: boolean;
}

function sessionsDir(
  sdk: Pick<OmpCodingAgentSdk, 'SessionManager'>,
  agentDir: string | undefined,
  cwd: string
): string | undefined {
  return agentDir ? sdk.SessionManager.getDefaultSessionDir(cwd, agentDir) : undefined;
}

/**
 * Resolve an OMP SessionManager for a sendQuery call.
 * Missing resume ids fall back to a fresh session with an explicit warning flag.
 */
export async function resolveOmpSession(
  sdk: Pick<OmpCodingAgentSdk, 'SessionManager'>,
  cwd: string,
  resumeSessionId: string | undefined,
  agentDir?: string
): Promise<ResolvedOmpSession> {
  const dir = sessionsDir(sdk, agentDir, cwd);

  if (!resumeSessionId) {
    return { sessionManager: sdk.SessionManager.create(cwd, dir), resumeFailed: false };
  }

  const sessions = await sdk.SessionManager.list(cwd, dir);
  const match = sessions.find(s => s.id === resumeSessionId);
  if (match) {
    return { sessionManager: await sdk.SessionManager.open(match.path, dir), resumeFailed: false };
  }

  return { sessionManager: sdk.SessionManager.create(cwd, dir), resumeFailed: true };
}
