import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface Applicability {
  fingerprint: string;
  scope: string;
  generation: number;
  reason: string;
  nonce: string;
}

interface ValidationVerdict {
  green: boolean;
  checks_performed: boolean;
  red_cause: 'introduced' | 'inherited' | 'environment' | '';
  summary: string;
}

interface StoredEvidence {
  applicability: Applicability;
  verdict: ValidationVerdict;
}

const artifactsDir = requiredEnv('ARTIFACTS_DIR');
const statePath = join(artifactsDir, '.validation-applicability.json');
const evidencePath = join(artifactsDir, 'validation-evidence.json');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`validation-evidence: ${name} is required`);
  return value;
}

function isApplicability(value: unknown): value is Applicability {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.scope === 'string' &&
    Number.isInteger(candidate.generation) &&
    (candidate.generation as number) > 0 &&
    typeof candidate.reason === 'string' &&
    typeof candidate.nonce === 'string'
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

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`validation-evidence: git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.toString();
}

function fingerprint(): string {
  const head = git('rev-parse', '--verify', 'HEAD').trim();
  const trackedDelta = git('diff', '--binary', '--no-ext-diff', 'HEAD', '--');
  return createHash('sha256')
    .update(JSON.stringify({ head, trackedDelta }))
    .digest('hex');
}

function sameApplicability(left: Applicability, right: Applicability): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function check(): Promise<void> {
  const scope = process.env.INPUTS_SCOPE ?? '';
  const currentFingerprint = fingerprint();
  const storedState = await readJson(statePath);
  const prior = isApplicability(storedState) ? storedState : undefined;
  const storedEvidence = await readJson(evidencePath);
  const evidence =
    storedEvidence !== null && typeof storedEvidence === 'object'
      ? (storedEvidence as Partial<StoredEvidence>)
      : undefined;

  if (
    prior !== undefined &&
    isApplicability(evidence?.applicability) &&
    isVerdict(evidence?.verdict) &&
    sameApplicability(prior, evidence.applicability) &&
    prior.fingerprint === currentFingerprint &&
    prior.scope === scope &&
    evidence.verdict.green &&
    evidence.verdict.checks_performed &&
    evidence.verdict.red_cause === ''
  ) {
    console.log(JSON.stringify(prior));
    return;
  }

  let reason = 'first validation for this run';
  if (prior !== undefined) {
    if (prior.fingerprint !== currentFingerprint) reason = 'tracked tree changed';
    else if (prior.scope !== scope) reason = 'validation scope changed';
    else if (storedEvidence === undefined) reason = 'validation evidence is missing';
    else if (!isApplicability(evidence?.applicability) || !isVerdict(evidence?.verdict)) {
      reason = 'validation evidence is unavailable';
    } else if (!evidence.verdict.green || evidence.verdict.red_cause !== '') {
      reason = 'prior validation was not green';
    } else if (!evidence.verdict.checks_performed) {
      reason = 'prior validation performed no checks';
    } else {
      reason = 'validation evidence does not match its applicability record';
    }
  }

  const applicability: Applicability = {
    fingerprint: currentFingerprint,
    scope,
    generation: (prior?.generation ?? 0) + 1,
    reason,
    nonce: randomUUID(),
  };
  await writeJson(statePath, applicability);
  console.log(JSON.stringify(applicability));
}

async function record(): Promise<void> {
  const applicabilityValue = JSON.parse(requiredEnv('INPUTS_APPLICABILITY')) as unknown;
  const verdictValue = JSON.parse(requiredEnv('INPUTS_VERDICT')) as unknown;
  if (!isApplicability(applicabilityValue)) {
    throw new Error('validation-evidence: applicability input is malformed');
  }
  if (!isVerdict(verdictValue)) {
    throw new Error('validation-evidence: verdict input is malformed');
  }
  await writeJson(evidencePath, {
    applicability: applicabilityValue,
    verdict: verdictValue,
  } satisfies StoredEvidence);
  console.log(JSON.stringify({ recorded: true, reason: applicabilityValue.reason }));
}

const action = requiredEnv('INPUTS_ACTION');
await (action === 'check'
  ? check()
  : action === 'record'
    ? record()
    : Promise.reject(new Error(`validation-evidence: unsupported action ${action}`)));
