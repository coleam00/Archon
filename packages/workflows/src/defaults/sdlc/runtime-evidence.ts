import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { captureHash, captureProducerSchema, readToolCaptures } from '../../tool-capture';

export const runtimeEvidenceSchema = z
  .object({
    report_path: z.string(),
    report_sha256: z.string(),
    capture_directory: z.string(),
    capture_manifest_sha256: z.string(),
    producer: captureProducerSchema.nullable(),
    scenario_path: z.string(),
    scenario_sha256: z.string(),
    evaluator_path: z.string(),
    evaluator_sha256: z.string(),
    evaluator_sources: z.array(z.object({ path: z.string(), sha256: z.string() }).strict()),
  })
  .strict();
interface RuntimeAssessment {
  status: 'verified' | 'failed' | 'inconclusive' | 'malformed';
  reason: string;
  candidate: string;
  evidence: z.infer<typeof runtimeEvidenceSchema>;
}

export const runtimeReportSchema = z
  .object({
    candidate: z.string(),
    assertions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            outcome: z.enum(['passed', 'failed', 'inconclusive']),
            expected: z.unknown(),
            observed: z.unknown(),
            reason: z.string().trim().min(1),
            evidence: z
              .array(
                z
                  .object({
                    call_id: z.string().min(1),
                    attachment: z.number().int().nonnegative().optional(),
                  })
                  .strict()
              )
              .min(1),
          })
          .strict()
          .refine(
            value => Object.hasOwn(value, 'expected') && Object.hasOwn(value, 'observed'),
            'expected and observed are required'
          )
      )
      .min(1),
  })
  .strict();

export interface RuntimeAssessmentInput {
  directory: string;
  reportPath: string;
  requiredIds: string[];
  expectedCandidate: string;
  startOk: boolean;
  identityOk: boolean;
  runId: string;
  scenario: string;
}

export async function runtimeEvaluatorSources(
  script: string
): Promise<RuntimeAssessment['evidence']['evaluator_sources']> {
  const pack = dirname(dirname(script));
  const paths = [join(pack, 'archon-verify-runtime.yaml')];
  for (const directory of ['commands', 'scripts']) {
    for (const entry of await readdir(join(pack, directory), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isFile()) paths.push(join(entry.parentPath, entry.name));
    }
  }
  return Promise.all(
    paths.sort().map(async path => ({
      path: await realpath(path),
      sha256: captureHash(await readFile(path)),
    }))
  );
}

export async function assessRuntime(input: RuntimeAssessmentInput): Promise<RuntimeAssessment> {
  const evidence: RuntimeAssessment['evidence'] = {
    report_path: input.reportPath,
    report_sha256: '',
    capture_directory: join(input.directory, 'captures'),
    capture_manifest_sha256: '',
    producer: null,
    scenario_path: input.scenario,
    scenario_sha256: '',
    evaluator_path: import.meta.path,
    evaluator_sha256: '',
    evaluator_sources: [],
  };
  const result = (
    status: 'verified' | 'failed' | 'inconclusive' | 'malformed',
    reason: string,
    candidate = ''
  ): RuntimeAssessment => ({ status, reason, candidate, evidence });
  if (!input.startOk)
    return result('inconclusive', 'environment setup or start failed; see node logs');
  if (!input.identityOk)
    return result('inconclusive', 'target identity probe failed; see node logs');
  const candidate = (await readFile(join(input.directory, 'target.txt'), 'utf8')).trim();
  if (candidate === '') return result('inconclusive', 'target identity probe returned no identity');
  if (input.expectedCandidate.trim() !== '' && candidate !== input.expectedCandidate.trim()) {
    return result(
      'inconclusive',
      'target identity does not match the requested candidate',
      candidate
    );
  }
  try {
    const directory = await realpath(input.directory);
    if ((await realpath(input.reportPath)) !== join(directory, 'report.json'))
      throw new Error('report path is outside this attempt');
    const bytes = await readFile(input.reportPath);
    const report = runtimeReportSchema.parse(JSON.parse(bytes.toString()) as unknown);
    if (report.candidate.trim() !== candidate)
      throw new Error('reported candidate does not match the target probe');
    const captured = await readToolCaptures(evidence.capture_directory, input.runId);
    const seen = new Set<string>();
    for (const assertion of report.assertions) {
      if (!input.requiredIds.includes(assertion.id) || seen.has(assertion.id))
        throw new Error('assertion ids must match the scenario exactly');
      seen.add(assertion.id);
      for (const ref of assertion.evidence) {
        const receipt = captured.receipts.find(
          entry => entry.receipt.callId === ref.call_id
        )?.receipt;
        if (
          receipt?.completeness !== 'full' ||
          receipt.truncated ||
          receipt.redacted ||
          receipt.outcome === 'interrupted' ||
          receipt.outcome === 'unknown'
        ) {
          throw new Error(
            `assertion ${assertion.id} references unavailable or incomplete execution`
          );
        }
        if (ref.attachment !== undefined && receipt.attachments[ref.attachment] === undefined) {
          throw new Error(`assertion ${assertion.id} has no captured attachment`);
        }
      }
    }
    if (seen.size !== input.requiredIds.length)
      throw new Error('report is missing required assertion coverage');
    evidence.report_sha256 = captureHash(bytes);
    evidence.capture_manifest_sha256 = captured.manifestFile.sha256;
    evidence.producer = captured.manifest.producer;
    evidence.scenario_sha256 = captureHash(await readFile(input.scenario));
    evidence.evaluator_sha256 = captureHash(await readFile(import.meta.path));
    const status = report.assertions.some(assertion => assertion.outcome === 'inconclusive')
      ? 'inconclusive'
      : report.assertions.some(assertion => assertion.outcome === 'failed')
        ? 'failed'
        : 'verified';
    return result(
      status,
      status === 'verified'
        ? 'declared assertions passed; execution capture and target identity checked'
        : 'one or more assertions failed or could not be assessed',
      candidate
    );
  } catch (error) {
    return result('malformed', error instanceof Error ? error.message : String(error), candidate);
  }
}

export async function runRuntimeEvidence(): Promise<void> {
  const env = z
    .object({
      INPUTS_DIRECTORY: z.string(),
      INPUTS_REPORT_PATH: z.string(),
      INPUTS_REQUIRED_IDS: z.string(),
      INPUTS_EXPECTED_CANDIDATE: z.string(),
      INPUTS_START_OK: z.enum(['true', 'false']),
      INPUTS_IDENTITY_OK: z.enum(['true', 'false']),
      WORKFLOW_ID: z.string(),
      INPUTS_SCENARIO: z.string(),
    })
    .parse(process.env);
  const assessment = await assessRuntime({
    directory: env.INPUTS_DIRECTORY,
    reportPath: env.INPUTS_REPORT_PATH,
    requiredIds: z.array(z.string()).parse(JSON.parse(env.INPUTS_REQUIRED_IDS) as unknown),
    expectedCandidate: env.INPUTS_EXPECTED_CANDIDATE,
    startOk: env.INPUTS_START_OK === 'true',
    identityOk: env.INPUTS_IDENTITY_OK === 'true',
    runId: env.WORKFLOW_ID,
    scenario: env.INPUTS_SCENARIO,
  });
  assessment.evidence.evaluator_sources = await runtimeEvaluatorSources(import.meta.path);
  console.log(JSON.stringify(assessment));
}
