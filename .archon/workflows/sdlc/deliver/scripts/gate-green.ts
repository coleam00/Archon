/**
 * The green gate: run success never certifies green — this does, deterministically.
 *
 * The delivery tail asks the question after implementation, after corrections, and
 * after the project's own full gate runs post-review. The same script answers it each
 * time. A node that produced a verdict is not a node that passed; the loop completes
 * on `done`, blocked declines included, so no spend and no public step happens until
 * this reads the verdict itself.
 *
 * Red is not one thing, though, and treating it as one killed two correct deliveries.
 *
 * A change that breaks a check must never reach a pull request. A check that was
 * already red at the run's starting commit, or that failed because a parallel process
 * held the database this run needed, is not evidence about the change at all — and
 * reality gets checked again downstream regardless: flip-ready refuses to make the PR
 * ready while its real CI is not green. So this fails on `introduced` and lets
 * `inherited` and `environment` through with the claim recorded where every downstream
 * reader meets it. An inherited base break stays red on the PR too, where the tail
 * pauses for explicit operator action instead of retrying or flipping the PR ready.
 *
 * That trade is only safe while it stays loud, so a passed red is never silent: the
 * record below is what the terminal report and the pull request body repeat. A record
 * that cannot be written fails the gate — passing red work with no trace of why is the
 * one outcome worse than refusing.
 *
 * `red_cause` is agent judgment. This validates the resolved value and nothing else;
 * the evidence behind it belongs to the declaring node's prompt and its report.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_GREEN: the declaring node's verdict, canonical boolean text.
 * - INPUTS_RED_CAUSE: a member of the pack's red-cause vocabulary, or '' when the
 *   declared-optional field is absent.
 * - INPUTS_SUMMARY: that node's summary, which carries the evidence for the claim.
 * - INPUTS_STAGE: which gate this is, for the record a human reads later.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, note, refuse, report, trimmed } from '../../.shared/io.ts';
import { RED_CAUSES, parseDeclaredRedCause, passesRed } from '../../.shared/verdict.ts';

/**
 * Append this gate's decision to the run's red-cause record.
 *
 * A list, not a document: the implementation, a correction, and the project gate can
 * each pass red for their own reason, and a later one must not erase an earlier. An
 * unreadable existing file is replaced rather than parsed around — the alternative is
 * failing a delivery over a file only this gate writes — while a failed WRITE
 * propagates, because the record is the whole reason passing red is allowed.
 */
function recordRedCause(artifacts: string, cause: string, stage: string, summary: string): void {
  const path = join(artifacts, 'red-causes.json');
  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    existing = undefined;
  }
  const records = Array.isArray(existing) ? existing : [];
  records.push({ cause, stage, summary });
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(path, JSON.stringify(records, null, 2), 'utf-8');
}

const artifacts = artifactsDir();
const green = trimmed(process.env.INPUTS_GREEN);
const rawCause = trimmed(process.env.INPUTS_RED_CAUSE);
const summary = trimmed(process.env.INPUTS_SUMMARY);
const stage = trimmed(process.env.INPUTS_STAGE) || 'The work';

const cause = parseDeclaredRedCause(rawCause);

if (green === 'true') {
  report('{"gate":"green"}');
} else if (cause === undefined || cause === '') {
  refuse(
    `${stage} is red and declared no usable red_cause ` +
      `(got '${rawCause}'; expected one of ${RED_CAUSES.join(', ')}). Red that nobody ` +
      'explained is red this gate refuses — its summary says what happened.'
  );
} else if (!passesRed(cause)) {
  refuse(
    `${stage} is red, and the cause is the change itself. ` +
      'Refusing to open or advance a pull request on red work.'
  );
} else if (summary === '') {
  // The label is not the claim. A pass on non-introduced red is worth exactly the
  // evidence behind it — the failing check named, and why this change cannot have
  // caused it — and an empty summary carries none, so the caveat it records says
  // nothing a reader can act on. Refused for the same reason an unwritable record is:
  // red that leaves no trace of why is worse than red that stops here. Emptiness is
  // all this checks; whether the prose is genuine evidence is the declaring agent's
  // judgment and the reviewer's, never something to reconstruct from the text.
  refuse(
    `${stage} declared its red ${cause}, but recorded no evidence for the claim. ` +
      'A pass on red the change did not cause is only as good as the failing check ' +
      'it names — refusing without it.'
  );
} else {
  let recorded = true;
  try {
    recordRedCause(artifacts, cause, stage, summary);
  } catch (error) {
    recorded = false;
    refuse(
      `${stage} declared '${cause}' red, but the caveat could not be recorded ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        'Refusing to pass red work that leaves no trace of why.'
    );
  }
  if (recorded) {
    note(
      `${stage} is red, and declared that red ${cause} rather than introduced. ` +
        "Proceeding so the pull request's own CI can be observed; a red conclusion " +
        'requires explicit operator action.'
    );
    report(JSON.stringify({ gate: 'green', red_cause: cause }));
  }
}
