import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface Applicability {
  fingerprint: string;
  scope: string;
  context: string;
  validator: string;
  generation: number;
  reason: string;
  nonce: string;
  reuse: boolean;
}

interface ValidationVerdict {
  green: boolean;
  checks_performed: boolean;
  red_cause: 'introduced' | 'inherited' | 'environment' | '';
  summary: string;
}

export interface StoredEvidence {
  applicability: Applicability;
  verdict: ValidationVerdict;
  report: { sha256: string; content: string };
  producer: { runId: string; attempt: string };
  sources: { path: string; sha256: string }[];
}

const statePath = (): string => join(requiredEnv('ARTIFACTS_DIR'), '.validation-applicability.json');
const evidencePath = (): string => join(requiredEnv('ARTIFACTS_DIR'), 'validation-evidence.json');
const reportPath = (): string => join(requiredEnv('ARTIFACTS_DIR'), 'validation.md');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`validation-evidence: ${name} is required`);
  return value;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isApplicability(value: unknown): value is Applicability {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.scope === 'string' &&
    typeof candidate.context === 'string' &&
    typeof candidate.validator === 'string' &&
    candidate.validator.length > 0 &&
    Number.isInteger(candidate.generation) &&
    (candidate.generation as number) > 0 &&
    typeof candidate.reason === 'string' &&
    typeof candidate.nonce === 'string' &&
    typeof candidate.reuse === 'boolean'
  );
}

function isVerdict(value: unknown): value is ValidationVerdict {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.green === 'boolean' &&
    typeof candidate.checks_performed === 'boolean' &&
    typeof candidate.summary === 'string' &&
    ['introduced', 'inherited', 'environment', ''].includes(String(candidate.red_cause))
  );
}

export function isValidationEvidence(value: unknown): value is StoredEvidence {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredEvidence>;
  const report = candidate.report;
  return (
    isApplicability(candidate.applicability) &&
    isVerdict(candidate.verdict) &&
    report !== undefined && report !== null && typeof report === 'object' &&
    typeof report.sha256 === 'string' &&
    typeof report.content === 'string' &&
    report.content.trim().length > 0 &&
    hash(report.content) === report.sha256 &&
    candidate.producer !== undefined && candidate.producer !== null && typeof candidate.producer === 'object' && typeof candidate.producer.runId === 'string' && candidate.producer.runId !== '' &&
    candidate.producer.attempt === candidate.applicability.nonce &&
    Array.isArray(candidate.sources) && candidate.sources.length === validatorPaths().length &&
    candidate.sources.every(source => source !== null && typeof source === 'object' && typeof source.path === 'string' && typeof source.sha256 === 'string')
  );
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function readReport(): Promise<string | undefined> {
  try {
    const content = await readFile(reportPath(), 'utf8');
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
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`validation-evidence: git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.toString();
}

export function validationFingerprint(cwd = process.cwd()): string {
  const head = git(cwd, 'rev-parse', '--verify', 'HEAD').trim();
  const trackedDelta = git(cwd, 'diff', '--binary', '--no-ext-diff', 'HEAD', '--');
  return hash(JSON.stringify({ head, trackedDelta }));
}

function validatorPaths(): string[] {
  const workflowDir = dirname(dirname(import.meta.path));
  return [import.meta.path, join(workflowDir, 'commands', 'validate.md'), join(workflowDir, 'archon-validate.yaml')];
}

async function validatorIdentity(): Promise<string> {
  const sources = await Promise.all(validatorPaths().map(path => readFile(path, 'utf8')));
  return hash(JSON.stringify(sources));
}

async function validatorSources(): Promise<StoredEvidence['sources']> {
  return Promise.all(validatorPaths()
    .map(async path => ({ path, sha256: hash(await readFile(path, 'utf8')) })));
}

async function currentIdentity(): Promise<
  Pick<Applicability, 'fingerprint' | 'scope' | 'context' | 'validator'>
> {
  return {
    fingerprint: validationFingerprint(),
    scope: process.env.INPUTS_SCOPE ?? '',
    context: process.env.INPUTS_CONTEXT ?? '',
    validator: await validatorIdentity(),
  };
}

function evidenceApplies(
  evidence: StoredEvidence,
  current: Awaited<ReturnType<typeof currentIdentity>>,
  report: string | undefined
): boolean {
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

async function check(): Promise<void> {
  const current = await currentIdentity();
  const storedState = await readJson(statePath());
  const prior = isApplicability(storedState) ? storedState : undefined;
  const storedEvidence = await readJson(evidencePath());
  const evidence = isValidationEvidence(storedEvidence) ? storedEvidence : undefined;
  const report = await readReport();

  if (evidence !== undefined && evidenceApplies(evidence, current, report)) {
    const reusable: Applicability = {
      ...evidence.applicability,
      reason: 'applicable evidence',
      reuse: true,
    };
    await writeJson(statePath(), reusable);
    console.log(JSON.stringify(reusable));
    return;
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
  await writeJson(statePath(), applicability);
  console.log(JSON.stringify(applicability));
}

async function record(): Promise<void> {
  const applicabilityValue = JSON.parse(requiredEnv('INPUTS_APPLICABILITY')) as unknown;
  const verdictValue = JSON.parse(requiredEnv('INPUTS_VERDICT')) as unknown;
  if (!isApplicability(applicabilityValue) || applicabilityValue.reuse) {
    throw new Error('validation-evidence: applicability input is malformed');
  }
  if (!isVerdict(verdictValue)) {
    throw new Error('validation-evidence: verdict input is malformed');
  }
  if (validationFingerprint() !== applicabilityValue.fingerprint) {
    throw new Error('validation-evidence: tracked tree changed while validation was running');
  }
  if (await validatorIdentity() !== applicabilityValue.validator) throw new Error('validation-evidence: validator changed while validation was running');
  const report = await readReport();
  if (report === undefined) {
    throw new Error('validation-evidence: validation.md is missing or empty');
  }
  await writeJson(evidencePath(), {
    applicability: applicabilityValue,
    verdict: verdictValue,
    report: { sha256: hash(report), content: report },
    producer: { runId: requiredEnv('WORKFLOW_ID'), attempt: applicabilityValue.nonce },
    sources: await validatorSources(),
  } satisfies StoredEvidence);
  console.log(JSON.stringify({ recorded: true, reason: applicabilityValue.reason }));
}

async function select(): Promise<void> {
  const applicabilityValue = JSON.parse(requiredEnv('INPUTS_APPLICABILITY')) as unknown;
  if (!isApplicability(applicabilityValue)) {
    throw new Error('validation-evidence: applicability input is malformed');
  }
  if (!applicabilityValue.reuse) {
    const verdictValue = JSON.parse(requiredEnv('INPUTS_VERDICT')) as unknown;
    if (!isVerdict(verdictValue)) {
      throw new Error('validation-evidence: verdict input is malformed');
    }
    console.log(JSON.stringify(verdictValue));
    return;
  }
  const evidence = await readJson(evidencePath());
  const report = await readReport();
  if (!isValidationEvidence(evidence) || !evidenceApplies(evidence, await currentIdentity(), report)) {
    throw new Error('validation-evidence: reusable evidence is no longer applicable');
  }
  console.log(JSON.stringify(evidence.verdict));
}

if (import.meta.main) {
const action = requiredEnv('INPUTS_ACTION');
await (action === 'check'
  ? check()
  : action === 'record'
    ? record()
    : action === 'select'
      ? select()
      : Promise.reject(new Error(`validation-evidence: unsupported action ${action}`)));
}
