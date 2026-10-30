/**
 * The revise workflow's acceptance: what a change to existing automation may touch,
 * and how it proves it broke nothing.
 *
 * Every rule here is deterministic. The agent proposes, and this code decides whether
 * the proposal is even eligible to reach a person.
 */

/** The most revision attempts. The loop's max_iterations sits one above it. */
export const MAX_REVISIONS = 3;

/**
 * Paths a revision may never touch. God mode's own files are its governance: the
 * trust ladder, its verdicts, and these rules. A revision that could rewrite them could
 * approve itself. Repository config chooses providers and models, so a change there
 * moves spend and capability rather than behaviour, and stays a person's edit.
 */
const FORBIDDEN = [/^\.archon\/workflows\/god-mode\//, /^\.archon\/config\.ya?ml$/];

/** Revisions improve the repository's automation and its policy documents, nothing else. */
const ALLOWED = /^\.archon\//;

export function governance(paths: string[]): string[] {
  const problems: string[] = [];
  for (const p of paths) {
    if (!ALLOWED.test(p)) problems.push(`\`${p}\` is outside \`.archon/\`; a revision changes only automation and its policy`);
    else if (FORBIDDEN.some((f) => f.test(p))) problems.push(`\`${p}\` is god mode's own governance or repository config`);
  }
  return problems;
}

export interface Snapshot {
  /** Workflows the engine's validator rejects. */
  invalid: string[];
  /** Fixtures `workflow test` reports failing. */
  failing: string[];
}

/** What the change made worse: anything failing now that was passing before it. */
export function regressions(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  const wasInvalid = new Set(before.invalid);
  const wasFailing = new Set(before.failing);
  for (const w of after.invalid) if (!wasInvalid.has(w)) out.push(`workflow \`${w}\` no longer validates`);
  for (const f of after.failing) if (!wasFailing.has(f)) out.push(`fixture \`${f}\` now fails`);
  return out;
}

export interface RevisionVerdict {
  attempt: number;
  done: boolean;
  valid: boolean;
  report: string;
}

export function judgeRevision(
  previous: number,
  paths: string[],
  governanceProblems: string[],
  regressed: string[],
  acceptance: { command: string; code: number; output: string }[],
): RevisionVerdict {
  const attempt = previous + 1;
  const last = attempt >= MAX_REVISIONS;
  const lines: string[] = [];
  if (paths.length === 0) lines.push('The revision changed no files.');
  for (const g of governanceProblems) lines.push(`Not allowed: ${g}.`);
  for (const r of regressed) lines.push(`Regression: ${r}.`);
  if (acceptance.length === 0) lines.push('The revision declared no acceptance commands.');
  for (const a of acceptance) {
    if (a.code !== 0) lines.push(`Acceptance failed: \`${a.command}\` exited ${a.code}\n${a.output}`);
  }
  const valid = lines.length === 0;
  if (valid) {
    lines.push(`Eligible: ${paths.length} file(s) changed, no regressions, every acceptance command passed.`);
    for (const p of paths) lines.push(`- ${p}`);
  }
  return { attempt, done: valid || last, valid, report: lines.join('\n') };
}
