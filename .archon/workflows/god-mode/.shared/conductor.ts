/**
 * The conductor's deterministic decisions: which charter stands, whether a person sees
 * the plan, whether the run proceeds, and what the missions actually achieved.
 */

import { type Mission, parseMission } from './mission.ts';
import { needsApproval, type Trust } from './trust.ts';

export interface Brief {
  problem: string;
  why: string;
  why_now: string;
  outcome: string;
  invariants: string[];
  acceptance: string[];
}

export interface Charter {
  complete: boolean;
  question: string;
  brief: Brief;
  approach: string;
  missions: Mission[];
}

/** The rewritten charter when the run asked for one, otherwise the first. */
export function standingCharter(first: Charter, second: Charter | null): Charter {
  const charter = second ?? first;
  if (!charter.complete) {
    // One question was asked and answered. A brief still incomplete after that is a
    // goal the run cannot state, and planning on a guess wastes every mission's spend.
    throw new Error(`the brief is still incomplete after one clarification: ${charter.question}`);
  }
  if (charter.missions.length === 0) throw new Error('the charter planned no missions');
  const ids = new Set<string>();
  for (const m of charter.missions) {
    parseMission(m);
    if (ids.has(m.id)) throw new Error(`two missions share the id \`${m.id}\``);
    ids.add(m.id);
  }
  return charter;
}

export interface Plan {
  missions: Mission[];
  count: number;
  gate: boolean;
  level: string;
  trust: string;
  message: string;
}

export function plan(charter: Charter, trust: Trust): Plan {
  const count = charter.missions.length;
  const gate = needsApproval(trust, count);
  const b = charter.brief;
  const lines = [
    `God mode wants to run ${count} mission${count === 1 ? '' : 's'}.`,
    '',
    `Problem: ${b.problem}`,
    `Why: ${b.why}`,
    `Why now: ${b.why_now}`,
    `Outcome: ${b.outcome}`,
    `Invariants: ${b.invariants.join('; ') || 'none stated'}`,
    `Acceptance: ${b.acceptance.join('; ')}`,
    '',
    `Approach: ${charter.approach}`,
    '',
    ...charter.missions.map((m) => `- ${m.id}: ${m.objective} [checks: ${m.acceptance.join(' && ')}]`),
    '',
    `Trust: ${trust.level} (${trust.reason}).`,
    count > trust.max_missions
      ? `This plan has more missions than the ${trust.level} cap of ${trust.max_missions}, so it needs your approval.`
      : 'Approve to run the missions, or reject to stop before any spend on them.',
  ];
  return {
    missions: charter.missions,
    count,
    gate,
    level: trust.level,
    trust: `${trust.level}: ${trust.reason}`,
    message: lines.join('\n'),
  };
}

export function proceed(gate: boolean, answer: { decision?: string; text?: string } | null): { go: boolean; reason: string } {
  if (!gate) return { go: true, reason: 'autonomy earned: the plan ran without a gate' };
  if (answer === null) return { go: false, reason: 'the plan gate did not complete' };
  if (answer.decision === 'approve') return { go: true, reason: 'a person approved the plan' };
  const note = answer.text?.trim();
  return { go: false, reason: `the plan was rejected${note ? `: ${note}` : ''}` };
}

export interface MissionResult {
  mission: string;
  succeeded: boolean;
  reason: string;
  attempts: number;
  summary: string;
  evidence: string;
  branch: string;
}

interface FailedSlot {
  archon_failed: true;
  error: string;
  status: string;
}

function isFailedSlot(r: unknown): r is FailedSlot {
  return r !== null && typeof r === 'object' && (r as { archon_failed?: unknown }).archon_failed === true;
}

export interface Tally {
  total: number;
  succeeded: number;
  failed: number;
  all_succeeded: boolean;
  report: string;
  outcomes: { mission: string; succeeded: boolean }[];
}

/** Reduce the fan-out's item-ordered results, counting a crashed child as a failure. */
export function tally(missions: Mission[], results: unknown[]): Tally {
  if (results.length !== missions.length) {
    throw new Error(`expected ${missions.length} mission results, got ${results.length}`);
  }
  const outcomes: { mission: string; succeeded: boolean }[] = [];
  const sections: string[] = [];
  results.forEach((r, i) => {
    const id = missions[i]?.id ?? `mission-${i}`;
    if (isFailedSlot(r)) {
      outcomes.push({ mission: id, succeeded: false });
      sections.push(`## ${id}: FAILED (child run ${r.status})\n${r.error}`);
      return;
    }
    const m = r as MissionResult;
    outcomes.push({ mission: id, succeeded: m.succeeded === true });
    sections.push(
      `## ${id}: ${m.succeeded ? 'SUCCEEDED' : `FAILED (${m.reason})`} after ${m.attempts} attempt(s)` +
        `${m.branch ? ` on \`${m.branch}\`` : ''}\n${m.summary}\n\n<details><summary>evidence</summary>\n\n` +
        `\`\`\`\n${m.evidence}\n\`\`\`\n</details>`,
    );
  });
  const succeeded = outcomes.filter((o) => o.succeeded).length;
  return {
    total: outcomes.length,
    succeeded,
    failed: outcomes.length - succeeded,
    all_succeeded: outcomes.length > 0 && succeeded === outcomes.length,
    report: sections.join('\n\n'),
    outcomes,
  };
}
