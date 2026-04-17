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
   * session starts (mirrors Codex's resume_thread_failed fallback at
   * packages/providers/src/codex/provider.ts:553-558).
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
  } catch {
    // list() can fail if the session dir doesn't exist yet — treat as
    // "not found" and fall through to a fresh session with a warning.
  }

  return { sessionManager: SessionManager.create(cwd), resumeFailed: true };
}
