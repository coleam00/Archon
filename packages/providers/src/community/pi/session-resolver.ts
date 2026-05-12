import { SessionManager } from '@mariozechner/pi-coding-agent';

/**
 * Result of resolving an Archon `resumeSessionId` against Pi's session store.
 */
export interface ResolvedSession {
  /** SessionManager to hand to createAgentSession. */
  sessionManager: SessionManager;
  /**
   * True when a resumeSessionId was provided but no matching session file
   * was found — caller should surface a system warning before the new
   * session starts. Mirrors the `resume_thread_failed` fallback pattern
   * the Codex provider uses.
   */
  resumeFailed: boolean;
}

/**
 * Resolve a Pi `SessionManager` for a sendQuery call.
 *
 * Behavior:
 *  - No resumeSessionId → fresh `SessionManager.create(cwd)`.
 *  - resumeSessionId matches a session file for this cwd → `SessionManager.open(path)`.
 *  - resumeSessionId provided but not found → fresh session, `resumeFailed: true`.
 *
 * Pi stores sessions as JSONL files under `~/.pi/agent/sessions/<encoded-cwd>/`
 * (or `$PI_CODING_AGENT_DIR/sessions/...`). This mirrors Claude's
 * `~/.claude/projects/` and Codex's thread store — the provider owns
 * session persistence; Archon just holds the opaque UUID.
 *
 * Lookup uses `SessionManager.list(cwd)` which scans only this cwd's
 * sessions. Cross-cwd resume (e.g. worktree switch) is deliberately not
 * supported in this pass — if a workflow moves to a different directory,
 * a fresh session is created. This matches Pi's own mental model and
 * avoids ambiguity.
 */
export async function resolvePiSession(
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
        sessionManager: SessionManager.open(match.path),
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
