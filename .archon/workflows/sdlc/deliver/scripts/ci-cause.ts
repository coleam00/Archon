/**
 * Decide what caused a red CI conclusion, from structured evidence.
 *
 * An agent reads the CI logs and reports where each failure lives, whether the
 * same check fails on the base commit, and whether a re-run reproduced it, then
 * claims a cause. This script holds the claim to that evidence:
 *
 * - A failure located in a file the pull request changes is `introduced`,
 *   whatever the claim. It cannot be inherited from a base that lacks the file.
 * - `inherited` stands only when the same check fails on the base commit.
 * - `environment` stands only when no re-run reproduced the failure, or when the
 *   red includes a check CI cancelled and no failure points at a file: a check that
 *   never ran (a runner never acquired) produced no failure to reproduce, and a
 *   re-run cancelled again is the same infrastructure fault, never a code red.
 * - `unavailable` (the evidence could not be read from this run) stands as claimed:
 *   it attributes nothing, so it goes to the operator, never to a fix.
 * - Anything else is `introduced`, and goes to the CI correction pass.
 *
 * The decision and every fact it rests on are this node's result, kept as a
 * typed artifact, so the operator sees why a run paused or corrected.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_CHANGED: the pull request's changed files, `{files: string[]}`.
 * - INPUTS_CANCELLED: JSON string array, the checks the CI probe saw concluded
 *   cancelled.
 * - INPUTS_FAILING_CHECKS / INPUTS_FAILING_PATHS: JSON string arrays.
 * - INPUTS_BASE: `fails`, `passes`, or `unknown`.
 * - INPUTS_RERUN: `fails`, `passes`, or `not_rerun`.
 * - INPUTS_CLAIM: `introduced`, `inherited`, `environment`, or `unavailable`.
 * - INPUTS_EVIDENCE: the agent's account of what it read.
 */

import { emit, refuse, text, trimmed } from '../../.shared/io.ts';

/** Forward slashes, no leading `./`, no trailing `:line` or `:line:column`. */
function normalize(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/(:\d+)+$/, '');
}

/**
 * A log can name a failing file by an absolute CI path (`D:/a/repo/repo/src/x.ts`),
 * so a failing path matches a changed file when it is that file or ends with it.
 */
function touches(failing: string, changed: string): boolean {
  return failing === changed || failing.endsWith(`/${changed}`);
}

function strings(label: string, value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error(`${label} is not a list of strings`);
  }
  return parsed as string[];
}

try {
  const changed = (JSON.parse(text(process.env.INPUTS_CHANGED)) as { files?: unknown }).files;
  if (!Array.isArray(changed)) throw new Error('the changed-file list has no `files` array');
  const changedFiles = (changed as string[]).map(normalize);
  const cancelled = strings('cancelled', text(process.env.INPUTS_CANCELLED));
  const failingChecks = strings('failing_checks', text(process.env.INPUTS_FAILING_CHECKS));
  const failingPaths = strings('failing_paths', text(process.env.INPUTS_FAILING_PATHS)).map(
    normalize
  );
  const base = trimmed(process.env.INPUTS_BASE);
  const rerun = trimmed(process.env.INPUTS_RERUN);
  const claim = trimmed(process.env.INPUTS_CLAIM);
  const evidence = trimmed(process.env.INPUTS_EVIDENCE);

  const inChange = failingPaths.filter(path => changedFiles.some(file => touches(path, file)));
  let cause: 'introduced' | 'inherited' | 'environment' | 'unavailable';
  let reason: string;
  if (inChange.length > 0) {
    cause = 'introduced';
    reason = `the failure is in ${inChange.join(', ')}, which this pull request changes`;
  } else if (claim === 'unavailable') {
    cause = 'unavailable';
    reason = 'the evidence that would attribute the failure could not be read from this run';
  } else if (claim === 'inherited' && base === 'fails') {
    cause = 'inherited';
    reason = 'the same check fails on the base commit, in files this pull request does not change';
  } else if (claim === 'environment' && cancelled.length > 0 && failingPaths.length === 0) {
    cause = 'environment';
    reason = `CI cancelled ${cancelled.join(', ')} before a result, and no failure points at a file`;
  } else if (claim === 'environment' && rerun !== 'fails') {
    cause = 'environment';
    reason =
      rerun === 'passes'
        ? 'the check passed when re-run, in files this pull request does not change'
        : 'the failure is in no file this pull request changes and was not re-run';
  } else if (claim === 'introduced') {
    cause = 'introduced';
    reason = 'the classifier attributed the failure to this branch';
  } else {
    cause = 'introduced';
    reason =
      claim === 'inherited'
        ? `it was claimed inherited, but the base commit's result is ${base}, not a failure`
        : 'it was claimed environment, but a re-run reproduced it';
  }
  const facts =
    `Failing checks: ${failingChecks.join(', ') || 'none named'}. ` +
    `Failing paths: ${failingPaths.join(', ') || 'none named'}. ` +
    `Base commit: ${base}. Re-run: ${rerun}. Claimed: ${claim}.`;
  emit({
    cause,
    failing_checks: failingChecks,
    failing_paths: failingPaths,
    changed_paths_failing: inChange,
    base,
    rerun,
    claim,
    evidence: `Classified ${cause}: ${reason}. ${facts} ${evidence}`.trim(),
  });
} catch (error) {
  refuse(`ci-cause: ${error instanceof Error ? error.message : String(error)}`);
}
