import { SessionManager } from '@oh-my-pi/pi-coding-agent';

/**
 * Result of resolving an Archon `resumeSessionId` against OMP's session store.
 */
export interface ResolvedSession {
  /** SessionManager to hand to createAgentSession. */
  sessionManager: SessionManager;
  /**
   * True when a resumeSessionId was provided but no matching session file
   * was found — caller should surface a system warning before the new
   * session starts. Mirrors the Pi provider's fallback pattern.
   */
  resumeFailed: boolean;
}

/**
 * Resolve an OMP `SessionManager` for a sendQuery call.
 *
 * Behavior:
 *  - No resumeSessionId → fresh `SessionManager.create(cwd)`.
 *  - resumeSessionId matches a session file for this cwd → `SessionManager.open(path)`.
 *  - resumeSessionId provided but not found → fresh session, `resumeFailed: true`.
 *
 * OMP stores sessions as JSONL files under `~/.omp/agent/sessions/<encoded-cwd>/`.
 * This mirrors Pi's session storage pattern.
 */
export async function resolveOmpSession(
  cwd: string,
  resumeSessionId: string | undefined
): Promise<ResolvedSession> {
  if (!resumeSessionId) {
    return { sessionManager: SessionManager.create(cwd), resumeFailed: false };
  }

  try {
    const sessions = await SessionManager.list(cwd);
    const match = sessions.find(s => s.id === resumeSessionId);
    if (match) {
      return {
        sessionManager: await SessionManager.open(match.path),
        resumeFailed: false,
      };
    }
  } catch (err: unknown) {
    // Only swallow "session dir doesn't exist yet" — any other error
    // (permission denied, corrupt JSONL, etc.) must propagate so failures
    // aren't papered over as a silent "no resume, fresh session" success.
    if (!isMissingSessionDirError(err)) throw err;
  }

  return { sessionManager: SessionManager.create(cwd), resumeFailed: true };
}

function isMissingSessionDirError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
