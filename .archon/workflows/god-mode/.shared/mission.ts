/**
 * The mission contract and the per-attempt verdict.
 *
 * A mission succeeds on evidence, never on the implementer's say-so: its acceptance
 * commands must exit 0 and an independent reviewer must approve. Both halves are
 * required because each catches what the other cannot. Commands cannot judge intent,
 * and a reviewer cannot be trusted to have actually run anything.
 */

export interface Mission {
  id: string;
  objective: string;
  context: string;
  done_when: string;
  acceptance: string[];
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The most attempts a mission gets. The loop's max_iterations sits one above it. */
export const MAX_ATTEMPTS = 3;

export function parseMission(raw: unknown): Mission {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('a mission is a JSON object');
  }
  const m = value as Record<string, unknown>;
  const str = (key: string): string => {
    const v = m[key];
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`mission field \`${key}\` must be non-empty text`);
    return v.trim();
  };
  const id = str('id');
  if (!KEBAB.test(id)) throw new Error(`mission id \`${id}\` must be kebab-case`);
  const acceptance = m.acceptance;
  if (!Array.isArray(acceptance) || acceptance.length === 0) {
    // A mission with nothing to run cannot be verified, and an unverifiable mission
    // would feed the trust ladder an outcome nobody proved.
    throw new Error(`mission \`${id}\` declares no acceptance commands`);
  }
  if (!acceptance.every((c) => typeof c === 'string' && c.trim() !== '')) {
    throw new Error(`mission \`${id}\` has an empty or non-text acceptance command`);
  }
  return {
    id,
    objective: str('objective'),
    context: typeof m.context === 'string' ? m.context.trim() : '',
    done_when: str('done_when'),
    acceptance: (acceptance as string[]).map((c) => c.trim()),
  };
}

export interface AttemptInput {
  previous: number;
  blocked: boolean | null;
  blocker: string;
  summary: string;
  pass: boolean | null;
  report: string;
  approve: boolean | null;
  findings: string;
}

export interface AttemptVerdict {
  attempt: number;
  done: boolean;
  succeeded: boolean;
  reason: 'accepted' | 'blocked' | 'attempts_exhausted' | 'retry' | 'node_failed';
  summary: string;
  feedback: string;
  evidence: string;
}

export function decideAttempt(input: AttemptInput): AttemptVerdict {
  const attempt = input.previous + 1;
  const last = attempt >= MAX_ATTEMPTS;
  const evidence = input.report;
  const base = { attempt, summary: input.summary, evidence };

  if (input.blocked === null || input.pass === null) {
    // execute or verify did not run: a body node failed. Retrying blind repeats it,
    // so the mission ends with the failure on record.
    return { ...base, done: true, succeeded: false, reason: 'node_failed', feedback: '' };
  }
  if (input.blocked) {
    return { ...base, done: true, succeeded: false, reason: 'blocked', feedback: input.blocker };
  }
  if (input.pass && input.approve === true) {
    return { ...base, done: true, succeeded: true, reason: 'accepted', feedback: '' };
  }
  const feedback = [
    input.pass ? 'Acceptance commands passed.' : `Acceptance commands FAILED:\n${input.report}`,
    input.findings.trim() === '' ? '' : `Reviewer findings:\n${input.findings}`,
  ]
    .filter((s) => s !== '')
    .join('\n\n');
  if (last) return { ...base, done: true, succeeded: false, reason: 'attempts_exhausted', feedback };
  return { ...base, done: false, succeeded: false, reason: 'retry', feedback };
}
