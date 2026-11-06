/**
 * Earned autonomy: how much rope the next god-mode run gets, computed from what past
 * runs actually did.
 *
 * The engine owns no policy (direction.md §user-owns-policy), so this ladder is pack
 * policy and lives here as code: deterministic, tested, and auditable through the
 * `god-mode/trust` state document every outcome is appended to. No agent sets its own
 * level. A model can only move up the ladder by producing missions whose deterministic
 * acceptance checks pass.
 */

export const TRUST_DOC = 'god-mode/trust';

/** How many recent outcomes the ladder reads. Older history neither helps nor hurts. */
export const WINDOW = 20;

export interface MissionRecord {
  at: string;
  run: string;
  mission: string;
  succeeded: boolean;
}

export interface TrustDoc {
  records: MissionRecord[];
}

export type Level = 'supervised' | 'trusted' | 'autonomous';

export interface Trust {
  level: Level;
  /** Outcomes in the window and how many passed. */
  window: number;
  passed: number;
  /** A plan wider than this always goes to a person, whatever the level. */
  max_missions: number;
  /** Whether a person approves the plan before any mission starts. */
  gate_plan: boolean;
  /** Why this level, in one line a person can check against the ledger. */
  reason: string;
}

const CAPS: Record<Level, number> = { supervised: 3, trusted: 8, autonomous: 20 };

export function assess(doc: TrustDoc | null): Trust {
  const recent = (doc?.records ?? []).slice(-WINDOW);
  const passed = recent.filter((r) => r.succeeded).length;
  const rate = recent.length === 0 ? 0 : passed / recent.length;
  const lastThree = recent.slice(-3);
  const tripped = lastThree.filter((r) => !r.succeeded).length >= 2;

  let level: Level;
  let reason: string;
  if (tripped) {
    // Circuit breaker: two of the last three missions failed. Whatever the long-run
    // record says, something changed, and a person looks before the next plan runs.
    level = 'supervised';
    reason = `circuit breaker: ${lastThree.filter((r) => !r.succeeded).length} of the last 3 missions failed`;
  } else if (recent.length >= 15 && rate >= 0.9 && recent.slice(-5).every((r) => r.succeeded)) {
    level = 'autonomous';
    reason = `${passed}/${recent.length} recent missions passed, the last 5 in a row`;
  } else if (recent.length >= 5 && rate >= 0.8) {
    level = 'trusted';
    reason = `${passed}/${recent.length} recent missions passed`;
  } else {
    level = 'supervised';
    reason =
      recent.length < 5
        ? `only ${recent.length} recorded missions; 5 are needed before any autonomy is earned`
        : `${passed}/${recent.length} recent missions passed; 80% is needed`;
  }
  return {
    level,
    window: recent.length,
    passed,
    max_missions: CAPS[level],
    gate_plan: level !== 'autonomous',
    reason,
  };
}

/** Whether this plan needs a person: the level asks for it, or the plan outgrew its cap. */
export function needsApproval(trust: Trust, missionCount: number): boolean {
  return trust.gate_plan || missionCount > trust.max_missions;
}
