import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { captureHash, captureProducerSchema, readToolCaptures } from '../../tool-capture';
import { assessRuntime, runtimeEvaluatorSources, runtimeEvidenceSchema } from './runtime-evidence';
import {
  isValidationEvidence,
  validationFingerprint,
} from '../../../../../.archon/workflows/sdlc/validate/scripts/validation-evidence';
import type {
  Hold,
  MergeFacts,
  SemanticAssessment,
} from '../../../../../.archon/workflows/sdlc/merge-queue/src/merge-queue';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const evidenceReferenceSchema = z.object({ path: z.string().min(1), sha256: sha }).strict();
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export const qualificationRequirementsSchema = z
  .object({
    scope: z.string(),
    context: z.string(),
    scenario: z.string(),
    holdout: z.string(),
  })
  .strict()
  .refine(
    value => (value.scenario === '') === (value.holdout === ''),
    'runtime and holdout scenarios must be supplied together'
  );
export type QualificationRequirements = z.infer<typeof qualificationRequirementsSchema>;
export function qualificationRequirementsFromEnv(): QualificationRequirements {
  return qualificationRequirementsSchema.parse({
    scope: process.env.INPUTS_SCOPE,
    context: process.env.INPUTS_CONTEXT,
    scenario: process.env.INPUTS_RUNTIME_SCENARIO,
    holdout: process.env.INPUTS_HOLDOUT_SCENARIO,
  });
}
export const runtimeResultSchema = z
  .object({
    verified: z.boolean(),
    verdict: z.enum(['verified', 'failed', 'inconclusive']),
    candidate: z.string().min(1),
    checkout: z.string().min(1),
    summary: z.string(),
    evidence: runtimeEvidenceSchema
      .extend({
        report_path: z.string().min(1),
        report_sha256: sha,
        capture_directory: z.string().min(1),
        capture_manifest_sha256: sha,
        producer: captureProducerSchema,
        scenario_path: z.string().min(1),
        scenario_sha256: sha,
        evaluator_path: z.string().min(1),
        evaluator_sha256: sha,
        evaluator_sources: z.array(evidenceReferenceSchema).min(1),
      })
      .strict(),
  })
  .strict();
export const verifiedRuntimeSchema = runtimeResultSchema.extend({
  verified: z.literal(true),
  verdict: z.literal('verified'),
});
export type VerifiedRuntime = z.infer<typeof verifiedRuntimeSchema>;
const pullIdentitySchema = z
  .object({
    url: z.string().url(),
    headSha: z.string().min(1),
    base: z.string().min(1),
    liveBaseSha: z.string().min(1),
    reviewFingerprint: sha,
  })
  .strict();
export const qualificationBundleSchema = z
  .object({
    version: z.literal(1),
    producer: z.object({ runId: z.string().min(1), attempt: z.uuid() }).strict(),
    source: z
      .object({
        checkout: z.string().min(1),
        fingerprint: sha,
        head: z.string().min(1),
        repository: z.string().min(1),
      })
      .strict(),
    requirements: qualificationRequirementsSchema,
    pulls: z.array(pullIdentitySchema).min(1).max(5),
    roles: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('runtime'),
          ordinary: evidenceReferenceSchema,
          ordinaryReport: evidenceReferenceSchema,
          runtime: verifiedRuntimeSchema,
          holdout: verifiedRuntimeSchema,
          review: evidenceReferenceSchema,
        })
        .strict(),
      z.object({ kind: z.literal('ordinary'), report: evidenceReferenceSchema }).strict(),
    ]),
    evaluator: z.array(evidenceReferenceSchema).min(1),
  })
  .strict();
export type QualificationBundle = z.infer<typeof qualificationBundleSchema>;
export const qualificationDecisionSchema = z
  .object({
    ready: z.boolean(),
    repair: z.boolean(),
    summary: z.string().trim().min(1),
    evidence: z.string().min(1),
    supporting_evidence: z.array(evidenceReferenceSchema),
    holds: z.array(
      z
        .object({
          kind: z.enum(['code', 'policy', 'checks', 'evidence', 'stale', 'authorization']),
          reason: z.string().trim().min(1),
        })
        .strict()
    ),
    method: z.enum(['merge', 'squash', 'rebase', '']),
    method_source: z.enum(['caller', 'project', '']),
    method_conflict: z.string(),
  })
  .strict()
  .refine(
    value =>
      !value.ready || (!value.repair && value.holds.length === 0 && value.method_conflict === ''),
    'ready conflicts with unresolved holds'
  );
export type QualificationDecision = z.infer<typeof qualificationDecisionSchema>;
export const qualifiedEvidenceSchema = z
  .object({
    bundle: qualificationBundleSchema,
    decision: qualificationDecisionSchema,
    report: evidenceReferenceSchema,
  })
  .strict()
  .refine(value => value.decision.ready, 'record is not qualified');
export type QualifiedEvidence = z.infer<typeof qualifiedEvidenceSchema>;

export async function evidenceReference(path: string): Promise<EvidenceReference> {
  const canonical = await realpath(path);
  return { path: canonical, sha256: captureHash(await readFile(canonical)) };
}

export async function readEvidence(reference: EvidenceReference): Promise<Buffer> {
  if ((await realpath(reference.path)) !== reference.path)
    throw new Error('evidence path ownership changed');
  const bytes = await readFile(reference.path);
  if (captureHash(bytes) !== reference.sha256)
    throw new Error(`evidence changed: ${reference.path}`);
  return bytes;
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0)
    throw new Error(`qualification git ${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

export function cleanQualificationHead(checkout: string): string {
  if (git(checkout, 'status', '--porcelain', '--untracked-files=normal') !== '')
    throw new Error('qualification requires a clean source checkout');
  return git(checkout, 'rev-parse', 'HEAD');
}

async function requirements(value: QualificationRequirements): Promise<QualificationRequirements> {
  return {
    ...value,
    scenario: value.scenario === '' ? '' : await realpath(value.scenario),
    holdout: value.holdout === '' ? '' : await realpath(value.holdout),
  };
}

export async function checkRuntime(
  runtime: z.infer<typeof runtimeResultSchema>,
  scenario: string,
  head: string
): Promise<void> {
  const evidence = runtime.evidence;
  if (runtime.checkout !== head || (await realpath(evidence.scenario_path)) !== scenario)
    throw new Error('runtime checkout or scenario does not match');
  await readEvidence({
    path: await realpath(evidence.report_path),
    sha256: evidence.report_sha256,
  });
  await readEvidence({ path: scenario, sha256: evidence.scenario_sha256 });
  await readEvidence({
    path: await realpath(evidence.evaluator_path),
    sha256: evidence.evaluator_sha256,
  });
  if (
    JSON.stringify(await runtimeEvaluatorSources(evidence.evaluator_path)) !==
    JSON.stringify(evidence.evaluator_sources)
  )
    throw new Error('runtime evaluator sources changed');
  const captures = await readToolCaptures(evidence.capture_directory, evidence.producer.runId);
  if (
    captures.manifestFile.sha256 !== evidence.capture_manifest_sha256 ||
    JSON.stringify(captures.manifest.producer) !== JSON.stringify(evidence.producer)
  )
    throw new Error('runtime capture producer or manifest changed');
  const declared = z
    .object({ assertions: z.array(z.object({ id: z.string().min(1) })).min(1) })
    .parse(JSON.parse(await readFile(scenario, 'utf8')) as unknown);
  const assessment = await assessRuntime({
    directory: dirname(evidence.report_path),
    reportPath: evidence.report_path,
    requiredIds: declared.assertions.map(assertion => assertion.id),
    expectedCandidate: runtime.candidate,
    startOk: true,
    identityOk: true,
    runId: evidence.producer.runId,
    scenario,
  });
  if (
    assessment.status !== runtime.verdict ||
    runtime.verified !== (runtime.verdict === 'verified') ||
    assessment.evidence.capture_directory !== evidence.capture_directory
  )
    throw new Error(`runtime evidence no longer verifies: ${assessment.reason}`);
}

export async function verifyQualificationBundle(
  bundle: QualificationBundle,
  expected: QualificationRequirements,
  facts: MergeFacts
): Promise<void> {
  const currentRequirements = await requirements(expected);
  if (
    Object.entries(currentRequirements).some(
      ([key, value]) => bundle.requirements[key as keyof QualificationRequirements] !== value
    )
  )
    throw new Error('qualification scope, context or scenarios changed');
  if (
    (await realpath(bundle.source.checkout)) !== bundle.source.checkout ||
    validationFingerprint(bundle.source.checkout) !== bundle.source.fingerprint ||
    cleanQualificationHead(bundle.source.checkout) !== bundle.source.head
  )
    throw new Error('qualified checkout or source changed');
  if (facts.repository !== bundle.source.repository)
    throw new Error('qualification repository changed');
  for (const pull of bundle.pulls) {
    const current = facts.pullRequests.find(value => value.url === pull.url);
    if (
      current?.headSha !== pull.headSha ||
      current.base !== pull.base ||
      current.liveBaseSha !== pull.liveBaseSha ||
      current.reviewFingerprint !== pull.reviewFingerprint
    )
      throw new Error('qualified head, base or review content changed');
    if (bundle.roles.kind === 'runtime' && pull.headSha !== bundle.source.head)
      throw new Error('qualified source does not match PR head');
  }
  for (const evaluator of bundle.evaluator) await readEvidence(evaluator);
  const roles = bundle.roles;
  if (roles.kind === 'ordinary') {
    if (expected.scenario !== '' || expected.holdout !== '')
      throw new Error('ordinary evidence cannot replace required runtime and holdout roles');
    if ((await readEvidence(roles.report)).toString().trim() === '')
      throw new Error('external validation and review report is empty');
    return;
  }
  if (bundle.pulls.length !== 1)
    throw new Error('runtime qualification requires one delivered candidate');
  const ordinary: unknown = JSON.parse((await readEvidence(roles.ordinary)).toString());
  if (
    !isValidationEvidence(ordinary) ||
    !ordinary.verdict.green ||
    !ordinary.verdict.checks_performed ||
    ordinary.verdict.red_cause !== '' ||
    ordinary.applicability.fingerprint !== bundle.source.fingerprint ||
    ordinary.applicability.scope !== expected.scope ||
    ordinary.applicability.context !== expected.context ||
    ordinary.producer.runId !== bundle.producer.runId
  )
    throw new Error('ordinary validation is missing, red or inapplicable');
  if (captureHash(await readEvidence(roles.ordinaryReport)) !== ordinary.report.sha256)
    throw new Error('ordinary validation report changed');
  for (const source of ordinary.sources) await readEvidence(source);
  if (bundle.requirements.scenario === bundle.requirements.holdout)
    throw new Error('independent holdout requires its own scenario');
  const runtimeProducer = roles.runtime.evidence.producer;
  const holdoutProducer = roles.holdout.evidence.producer;
  if (
    runtimeProducer.runId !== bundle.producer.runId ||
    holdoutProducer.runId !== bundle.producer.runId ||
    runtimeProducer.nodeId === holdoutProducer.nodeId ||
    runtimeProducer.attempt === holdoutProducer.attempt
  )
    throw new Error('holdout requires a distinct fresh producer');
  await checkRuntime(roles.runtime, bundle.requirements.scenario, bundle.source.head);
  await checkRuntime(roles.holdout, bundle.requirements.holdout, bundle.source.head);
  await readEvidence(roles.review);
}

export async function prepareQualification(input: {
  checkout: string;
  runId: string;
  artifactsDir: string;
  expected: QualificationRequirements;
  facts: MergeFacts;
  runtime: unknown;
  holdout: unknown;
  evaluator: string[];
}): Promise<QualificationBundle> {
  const checkout = await realpath(input.checkout);
  const bundle = qualificationBundleSchema.parse({
    version: 1,
    producer: { runId: input.runId, attempt: randomUUID() },
    source: {
      checkout,
      fingerprint: validationFingerprint(checkout),
      head: git(checkout, 'rev-parse', 'HEAD'),
      repository: input.facts.repository,
    },
    requirements: await requirements(input.expected),
    pulls: input.facts.pullRequests.map(pull => ({
      url: pull.url,
      headSha: pull.headSha,
      base: pull.base,
      liveBaseSha: pull.liveBaseSha,
      reviewFingerprint: pull.reviewFingerprint,
    })),
    roles: {
      kind: 'runtime',
      ordinary: await evidenceReference(join(input.artifactsDir, 'validation-evidence.json')),
      ordinaryReport: await evidenceReference(join(input.artifactsDir, 'validation.md')),
      runtime: input.runtime,
      holdout: input.holdout,
      review: await evidenceReference(join(input.artifactsDir, 'review/report.md')),
    },
    evaluator: await Promise.all(input.evaluator.map(evidenceReference)),
  });
  await verifyQualificationBundle(bundle, input.expected, input.facts);
  return bundle;
}

export async function prepareOrdinaryQualification(input: {
  checkout: string;
  runId: string;
  expected: QualificationRequirements;
  facts: MergeFacts;
  report: string;
  evaluator: string[];
}): Promise<QualificationBundle> {
  const checkout = await realpath(input.checkout);
  const bundle = qualificationBundleSchema.parse({
    version: 1,
    producer: { runId: input.runId, attempt: randomUUID() },
    source: {
      checkout,
      fingerprint: validationFingerprint(checkout),
      head: git(checkout, 'rev-parse', 'HEAD'),
      repository: input.facts.repository,
    },
    requirements: await requirements(input.expected),
    pulls: input.facts.pullRequests.map(pull => ({
      url: pull.url,
      headSha: pull.headSha,
      base: pull.base,
      liveBaseSha: pull.liveBaseSha,
      reviewFingerprint: pull.reviewFingerprint,
    })),
    roles: { kind: 'ordinary', report: await evidenceReference(input.report) },
    evaluator: await Promise.all(input.evaluator.map(evidenceReference)),
  });
  await verifyQualificationBundle(bundle, input.expected, input.facts);
  return bundle;
}

export async function writeEvidence(path: string, value: unknown): Promise<EvidenceReference> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
  await rename(temporary, path);
  return evidenceReference(path);
}

export async function sealQualification(
  bundle: QualificationBundle,
  decision: QualificationDecision,
  expected: QualificationRequirements,
  facts: MergeFacts,
  path: string
): Promise<EvidenceReference> {
  await verifyQualificationBundle(bundle, expected, facts);
  const report = await evidenceReference(decision.evidence);
  if ((await readEvidence(report)).toString().trim() === '')
    throw new Error('qualification report is empty');
  for (const reference of decision.supporting_evidence) await readEvidence(reference);
  return writeEvidence(path, qualifiedEvidenceSchema.parse({ bundle, decision, report }));
}

export async function inspectQualifications(
  references: EvidenceReference[],
  expected: QualificationRequirements,
  facts: MergeFacts
): Promise<SemanticAssessment> {
  const holds: Hold[] = [];
  const decisions: QualificationDecision[] = [];
  const covered = new Set<string>();
  try {
    if (references.length === 0 || references.length > 5)
      throw new Error('one qualified record per PR is required');
    for (const reference of references) {
      const record = qualifiedEvidenceSchema.parse(
        JSON.parse((await readEvidence(reference)).toString()) as unknown
      );
      await verifyQualificationBundle(record.bundle, expected, facts);
      await readEvidence(record.report);
      for (const evidence of record.decision.supporting_evidence) await readEvidence(evidence);
      for (const pull of record.bundle.pulls) {
        if (covered.has(pull.url)) throw new Error('duplicate qualified PR');
        covered.add(pull.url);
      }
      decisions.push(record.decision);
    }
    if (
      covered.size !== facts.pullRequests.length ||
      facts.pullRequests.some(pull => !covered.has(pull.url))
    )
      throw new Error('qualification does not cover the exact PR batch');
  } catch (error) {
    holds.push({
      kind: 'evidence',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const first = decisions[0];
  const conflict = decisions.some(
    decision => decision.method !== first?.method || decision.method_source !== first?.method_source
  );
  return {
    ready: holds.length === 0,
    summary:
      holds.map(hold => hold.reason).join('; ') ||
      decisions.map(decision => decision.summary).join('; '),
    holds,
    method: first?.method ?? '',
    method_source: first?.method_source ?? '',
    method_conflict: conflict ? 'qualified records disagree on merge method' : '',
    evidence: {
      state: holds.length === 0 ? 'qualified' : 'stale',
      fingerprint: captureHash(JSON.stringify(references)),
      references: references.map(reference => reference.path),
    },
  };
}
