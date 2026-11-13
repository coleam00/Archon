/**
 * Run the engine's validator and a dry run on the draft, and decide whether the loop
 * is done. Always exits 0: a rejected draft is feedback for the next attempt.
 * Bound inputs: INPUTS_NAME, INPUTS_SUMMARY, INPUTS_PREVIOUS (empty on the first attempt).
 */
import { existsSync } from 'node:fs';
import { cli } from '../../.shared/archon.ts';
import { type DryRunReport, forgedDir, judgeDraft, type ValidateReport } from '../../.shared/forge.ts';
import { emit, json, run, text } from '../../.shared/io.ts';

function parsed<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // The CLI printed something other than its JSON report; the raw text goes back to
    // the author as the evidence, so nothing is lost by not parsing it.
    return null;
  }
}

run('forge check', () => {
  const name = text(process.env.INPUTS_NAME);
  const summary = text(process.env.INPUTS_SUMMARY);
  const previousRaw = json(process.env.INPUTS_PREVIOUS);
  const previous = typeof previousRaw === 'number' ? previousRaw : 0;
  const dir = forgedDir(name);
  if (!existsSync(`${dir}/${name}.yaml`)) {
    emit({
      ...judgeDraft(name, previous, null, `expected the workflow at ${dir}/${name}.yaml, and it is not there`, null, ''),
      name,
      summary,
    });
    return;
  }
  const validated = cli(['validate', 'workflows', name, '--json']);
  const validate = parsed<ValidateReport>(validated.stdout);
  const ok = validate?.results.find((r) => r.workflowName === name)?.valid === true;
  const dried = ok ? cli(['workflow', 'run', name, '--dry-run', '--default-stubs', '--json']) : null;
  const dry = dried === null ? null : parsed<DryRunReport>(dried.stdout);
  const verdict = judgeDraft(
    name,
    previous,
    validate,
    `${validated.stdout}${validated.stderr}`,
    dry,
    dried === null ? '' : `${dried.stdout}${dried.stderr}`,
  );
  emit({ ...verdict, name, summary });
});
