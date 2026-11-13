/**
 * The forge's acceptance: a workflow an agent wrote counts as built only when the
 * engine's own validator accepts it and a deterministic dry run reaches an end.
 *
 * Both checks come from the engine (`archon validate workflows`, `archon workflow run
 * --dry-run`), never from a second implementation here, so the forge can never accept
 * YAML the engine would refuse.
 */

export const FORGED_ROOT = '.archon/workflows/forged';

/** The most authoring attempts. The loop's max_iterations sits one above it. */
export const MAX_DRAFTS = 3;

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function forgedDir(name: string): string {
  if (!KEBAB.test(name)) throw new Error(`forged workflow name \`${name}\` must be kebab-case`);
  return `${FORGED_ROOT}/${name}`;
}

export interface ValidateReport {
  results: { workflowName: string; valid: boolean; issues: { level: string; field?: string; message: string }[] }[];
}

export interface DryRunReport {
  outcome: string;
  missingStubs?: string[];
}

export interface CheckVerdict {
  attempt: number;
  done: boolean;
  valid: boolean;
  report: string;
}

/**
 * Judge one draft. `validate` is null when the validator could not run at all, and
 * `dry` is null when the dry run was not reached or produced no JSON.
 */
export function judgeDraft(
  name: string,
  previous: number,
  validate: ValidateReport | null,
  validateRaw: string,
  dry: DryRunReport | null,
  dryRaw: string,
): CheckVerdict {
  const attempt = previous + 1;
  const last = attempt >= MAX_DRAFTS;
  const result = validate?.results.find((r) => r.workflowName === name);
  const lines: string[] = [];
  let valid = false;
  if (result === undefined) {
    lines.push(`The validator found no workflow named \`${name}\`. Output:\n${validateRaw}`);
  } else if (!result.valid) {
    lines.push('`archon validate workflows` rejected the draft:');
    for (const i of result.issues) lines.push(`- [${i.level}] ${i.field ? `${i.field}: ` : ''}${i.message}`);
  } else if (dry === null) {
    lines.push(`The draft validates, but the dry run produced no result:\n${dryRaw}`);
  } else if (dry.outcome !== 'completed' && dry.outcome !== 'paused') {
    lines.push(`The draft validates, but the dry run ended \`${dry.outcome}\`:\n${dryRaw.slice(-4000)}`);
  } else {
    valid = true;
    const warnings = result.issues.filter((i) => i.level !== 'error');
    lines.push(`Valid. Dry run ended \`${dry.outcome}\`.`);
    for (const w of warnings) lines.push(`- [${w.level}] ${w.message}`);
  }
  return { attempt, done: valid || last, valid, report: lines.join('\n') };
}
