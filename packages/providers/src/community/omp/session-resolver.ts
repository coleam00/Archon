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

function isMissingSessionError(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  return (
    err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.message?.includes('ENOENT') === true
  );
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

  try {
    const sessions = await sdk.SessionManager.list(cwd, dir);
    const match = sessions.find(s => s.id === resumeSessionId);
    if (match) {
      try {
        return {
          sessionManager: await sdk.SessionManager.open(match.path, dir),
          resumeFailed: false,
        };
      } catch (error) {
        if (!isMissingSessionError(error)) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Oh My Pi session resume failed for '${resumeSessionId}': ${message}`);
        }
      }
    }
  } catch (error) {
    if (!isMissingSessionError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Oh My Pi session resume failed for '${resumeSessionId}': ${message}`);
    }
    return { sessionManager: sdk.SessionManager.create(cwd, dir), resumeFailed: true };
  }

  return { sessionManager: sdk.SessionManager.create(cwd, dir), resumeFailed: true };
}
