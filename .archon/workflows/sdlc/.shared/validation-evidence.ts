/**
 * Validation evidence: when a verdict archon-validate already reached still applies.
 *
 * A run that pauses and resumes (an approval, a wait on CI, an operator's resume)
 * reaches its validation again. Re-running the project's gate there costs the whole
 * gate's time and proves nothing new when nothing it measured has changed. The
 * evidence recorded here is what lets the second pass reuse the first verdict, and
 * the rules below are what keep that reuse honest.
 *
 * A verdict is recorded with everything it was a verdict about:
 * - the tracked tree (`HEAD` plus the binary diff of tracked files against it);
 * - the validation scope and the caller's nonsecret validation context, which names
 *   external state (a database snapshot, a service version) the tree cannot measure;
 * - the validator itself: this pack's validate workflow, commands and scripts;
 * - the exact `validation.md` report the verdict came with.
 *
 * Only a green verdict with performed checks and no red cause is ever reused, and
 * only while every one of those still matches. Anything else, including a missing or
 * unreadable record, runs the gate again. Reuse is an optimization: every doubt
 * resolves toward validating.
 *
 * Bindings are read by the entry scripts; nothing here reads an `INPUTS_*` value.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { artifactsDir } from './io.ts';

export interface Applicability {
  fingerprint: string;
  scope: string;
  context: string;
  validator: string;
  generation: number;
  reason: string;
  nonce: string;
  reuse: boolean;
}

export type RedCause =
  | 'introduced'
  | 'inherited'
  | 'environment'
  | 'interaction'
  | 'incomplete'
  | '';

/** archon-validate's result, exactly as its `result` node certifies it. */
export interface ValidationVerdict {
  green: boolean;
  checks_performed: boolean;
  red_cause: RedCause;
  summary: string;
  evidence: { type: 'archon_artifact'; run_id: string; path: string } | null;
}

interface StoredEvidence {
  applicability: Applicability;
  verdict: ValidationVerdict;
  report: { sha256: string; content: string };
}

/** The files whose content decides a verdict, relative to the pack root. */
const VALIDATOR_SOURCES = [
  'validate/archon-validate.yaml',
  'validate/commands/discover-checks.md',
  'validate/commands/classify-red.md',
  'validate/scripts/applicability.ts',
  'validate/scripts/run-checks.ts',
  'validate/scripts/result.ts',
  '.shared/validation-evidence.ts',
  '.shared/node-env.ts',
  '.shared/io.ts',
];

const RED_CAUSES: readonly string[] = [
  'introduced',
  'inherited',
  'environment',
  'interaction',
  'incomplete',
  '',
];

function paths(): { state: string; evidence: string; report: string } {
  const artifacts = artifactsDir();
  return {
    state: join(artifacts, '.validation-applicability.json'),
    evidence: join(artifacts, 'validation-evidence.json'),
    report: join(artifacts, 'validation.md'),
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isApplicability(value: unknown): value is Applicability {
  if (!isRecord(value)) return false;
  return (
    typeof value.fingerprint === 'string' &&
    typeof value.scope === 'string' &&
    typeof value.context === 'string' &&
    typeof value.validator === 'string' &&
    value.validator.length > 0 &&
    Number.isInteger(value.generation) &&
    (value.generation as number) > 0 &&
    typeof value.reason === 'string' &&
    typeof value.nonce === 'string' &&
    typeof value.reuse === 'boolean'
  );
}

export function isVerdict(value: unknown): value is ValidationVerdict {
  if (!isRecord(value)) return false;
  return (
    typeof value.green === 'boolean' &&
    typeof value.checks_performed === 'boolean' &&
    typeof value.summary === 'string' &&
    typeof value.red_cause === 'string' &&
    RED_CAUSES.includes(value.red_cause) &&
    (value.evidence === null || isRecord(value.evidence))
  );
}

function isEvidence(value: unknown): value is StoredEvidence {
  if (!isRecord(value)) return false;
  const report = value.report;
  return (
    isApplicability(value.applicability) &&
    isVerdict(value.verdict) &&
    isRecord(report) &&
    typeof report.sha256 === 'string' &&
    typeof report.content === 'string' &&
    report.content.trim().length > 0 &&
    hash(report.content) === report.sha256
  );
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function readReport(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, 'utf8');
    return content.trim().length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`validation evidence: git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.toString();
}

/**
 * The tracked tree under validation. Untracked files are left out on purpose: an
 * Archon run injects untracked scaffolding into the checkout, and the gate's own
 * ignored outputs are not the change.
 */
export function treeFingerprint(cwd: string): string {
  const head = git(cwd, 'rev-parse', '--verify', 'HEAD').trim();
  const trackedDelta = git(cwd, 'diff', '--binary', '--no-ext-diff', 'HEAD', '--');
  return hash(JSON.stringify({ head, trackedDelta }));
}

/**
 * The validator's identity: the content of every source that decides a verdict.
 * A packaged binary materializes the scripts alone, so a source that is not on
 * disk is recorded as absent rather than failing the check; a changed script still
 * changes the identity.
 */
export async function validatorIdentity(packRoot: string): Promise<string> {
  const sources = await Promise.all(
    VALIDATOR_SOURCES.map(async relative => {
      try {
        return [relative, await readFile(join(packRoot, relative), 'utf8')];
      } catch {
        return [relative, null];
      }
    })
  );
  return hash(JSON.stringify(sources));
}

type Identity = Pick<Applicability, 'fingerprint' | 'scope' | 'context' | 'validator'>;

async function currentIdentity(
  cwd: string,
  packRoot: string,
  scope: string,
  context: string
): Promise<Identity> {
  return {
    fingerprint: treeFingerprint(cwd),
    scope,
    context,
    validator: await validatorIdentity(packRoot),
  };
}

function applies(evidence: StoredEvidence, current: Identity, report: string | undefined): boolean {
  const prior = evidence.applicability;
  return (
    prior.fingerprint === current.fingerprint &&
    prior.scope === current.scope &&
    prior.context === current.context &&
    prior.validator === current.validator &&
    evidence.verdict.green &&
    evidence.verdict.checks_performed &&
    evidence.verdict.red_cause === '' &&
    report !== undefined &&
    hash(report) === evidence.report.sha256 &&
    report === evidence.report.content
  );
}

/**
 * Decide whether this validation can reuse the recorded verdict. Always writes
 * the decision to the run's state file and returns it; `reason` names why a fresh
 * validation is needed, or `applicable evidence` when it is not.
 */
export async function checkApplicability(
  cwd: string,
  packRoot: string,
  scope: string,
  context: string
): Promise<Applicability> {
  const files = paths();
  const current = await currentIdentity(cwd, packRoot, scope, context);
  const storedState = await readJson(files.state);
  const prior = isApplicability(storedState) ? storedState : undefined;
  const storedEvidence = await readJson(files.evidence);
  const evidence = isEvidence(storedEvidence) ? storedEvidence : undefined;
  const report = await readReport(files.report);

  if (evidence !== undefined && applies(evidence, current, report)) {
    const reusable: Applicability = {
      ...evidence.applicability,
      reason: 'applicable evidence',
      reuse: true,
    };
    await writeJson(files.state, reusable);
    return reusable;
  }

  let reason = 'first validation for this run';
  const previous = evidence?.applicability ?? prior;
  if (previous !== undefined) {
    if (previous.fingerprint !== current.fingerprint) reason = 'tracked tree changed';
    else if (previous.scope !== current.scope) reason = 'validation scope changed';
    else if (previous.context !== current.context) reason = 'validation context changed';
    else if (previous.validator !== current.validator) reason = 'validator changed';
    else if (storedEvidence === undefined) reason = 'validation evidence is missing';
    else if (evidence === undefined) reason = 'validation evidence is unavailable';
    else if (!evidence.verdict.green || evidence.verdict.red_cause !== '') {
      reason = 'prior validation was not green';
    } else if (!evidence.verdict.checks_performed) {
      reason = 'prior validation performed no checks';
    } else if (report === undefined) {
      reason = 'validation report is missing or empty';
    } else {
      reason = 'validation report changed';
    }
  }

  const applicability: Applicability = {
    ...current,
    generation: Math.max(prior?.generation ?? 0, evidence?.applicability.generation ?? 0) + 1,
    reason,
    nonce: randomUUID(),
    reuse: false,
  };
  await writeJson(files.state, applicability);
  return applicability;
}

/**
 * Bind a fresh verdict to what it measured. Returns why nothing was recorded, or
 * null when the evidence was written. Nothing recorded only means the next pass
 * validates again: a verdict whose tree moved under the gate, or that came with no
 * report, is never evidence for anything.
 */
export async function recordEvidence(
  cwd: string,
  applicability: Applicability,
  verdict: ValidationVerdict
): Promise<string | null> {
  if (applicability.reuse) {
    throw new Error('validation evidence: a reused verdict is not recorded again.');
  }
  const files = paths();
  if (treeFingerprint(cwd) !== applicability.fingerprint) {
    return 'the tracked tree changed while validation was running';
  }
  const report = await readReport(files.report);
  if (report === undefined) return 'validation.md is missing or empty';
  await writeJson(files.evidence, {
    applicability,
    verdict,
    report: { sha256: hash(report), content: report },
  } satisfies StoredEvidence);
  return null;
}

/**
 * The recorded verdict a reuse decision selected, re-checked against the current
 * identity. Throws when it no longer applies: a reuse decision whose evidence moved
 * is a contradiction, never a reason to report a verdict nobody reached.
 */
export async function reusedVerdict(
  cwd: string,
  packRoot: string,
  scope: string,
  context: string
): Promise<ValidationVerdict> {
  const files = paths();
  const evidence = await readJson(files.evidence);
  const report = await readReport(files.report);
  const current = await currentIdentity(cwd, packRoot, scope, context);
  if (!isEvidence(evidence) || !applies(evidence, current, report)) {
    throw new Error('validation evidence: the reusable evidence is no longer applicable.');
  }
  return evidence.verdict;
}
