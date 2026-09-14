import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { validationFingerprint } from '../../../../../.archon/workflows/sdlc/validate/scripts/validation-evidence';
import {
  collectMergeFacts,
  GhAdapter,
  isFacts,
  type Hold,
  type GitHubAdapter,
} from '../../../../../.archon/workflows/sdlc/merge-queue/src/merge-queue';
import {
  evidenceReferenceSchema,
  prepareQualification,
  prepareOrdinaryQualification,
  qualificationBundleSchema,
  qualificationDecisionSchema,
  qualificationRequirementsFromEnv,
  qualificationRequirementsSchema,
  readEvidence,
  sealQualification,
  writeEvidence,
  checkRuntime,
  runtimeResultSchema,
  cleanQualificationHead,
} from './qualified-evidence';

const candidateSchema = z
  .object({ delivered: z.boolean(), prs: z.array(z.string()), head: z.string() })
  .strict();
const repairEvidenceSchema = z
  .object({ runtime: runtimeResultSchema, scenario: z.string(), head: z.string() })
  .strict();
export const preparedSchema = z
  .object({
    available: z.boolean(),
    input: evidenceReferenceSchema.nullable(),
    report_path: z.string(),
    summary: z.string(),
    references: z.array(evidenceReferenceSchema),
  })
  .strict();

export const qualificationResultSchema = z
  .object({
    ready: z.boolean(),
    repair: z.boolean(),
    evidence: z.string(),
    summary: z.string(),
    references: z.array(evidenceReferenceSchema),
    holds: qualificationDecisionSchema.shape.holds,
  })
  .strict()
  .refine(
    value =>
      !value.ready || (!value.repair && value.references.length > 0 && value.holds.length === 0),
    'ready requires qualified references without holds'
  );

function inputText(name: string): string {
  const text = process.env[`INPUTS_${name}`];
  if (text === undefined) throw new Error(`qualification input ${name} is required`);
  return text;
}

function input(name: string): unknown {
  return JSON.parse(inputText(name)) as unknown;
}

function mergeEvidenceInput(): unknown {
  const value = z.string().min(1).parse(inputText('EVIDENCE'));
  // Exec bindings preserve path strings and JSON-encode structured references.
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function runQualification(
  adapter: GitHubAdapter = new GhAdapter(),
  script = import.meta.path
): Promise<void> {
  const artifacts = z.string().min(1).parse(process.env.ARTIFACTS_DIR);
  const expected = qualificationRequirementsFromEnv();
  if (process.env.INPUTS_ACTION === 'prepare-merge') {
    const evidence = mergeEvidenceInput();
    if (Array.isArray(evidence)) {
      const references = z.array(evidenceReferenceSchema).min(1).max(5).parse(evidence);
      console.log(
        JSON.stringify({
          available: false,
          input: null,
          report_path: '',
          summary: 'qualified references supplied; plan must recheck applicability',
          references,
        })
      );
      return;
    }
    const report = z.string().min(1).parse(evidence);
    const facts = input('FACTS');
    if (!isFacts(facts)) throw new Error('qualification facts are malformed');
    const workflowDir = dirname(dirname(script));
    const directory = join(artifacts, 'qualified-evidence', randomUUID());
    let bundle = null;
    let structuralError = '';
    try {
      bundle = await prepareOrdinaryQualification({
        checkout: process.cwd(),
        runId: z.string().min(1).parse(process.env.WORKFLOW_ID),
        expected,
        facts,
        report,
        evaluator: [
          script,
          join(workflowDir, 'commands/qualify-evidence.md'),
          join(workflowDir, 'archon-merge-queue.yaml'),
        ],
      });
    } catch (error) {
      structuralError = error instanceof Error ? error.message : String(error);
    }
    const reference = await writeEvidence(join(directory, 'input.json'), {
      bundle,
      facts,
      externalReport: report,
      repairEvidence: null,
      requirements: expected,
      structuralError,
      sourceFingerprint: validationFingerprint(),
    });
    console.log(
      JSON.stringify({
        available: true,
        input: reference,
        report_path: join(directory, 'qualification.md'),
        summary: structuralError || 'ordinary evidence ready for semantic qualification',
        references: [],
      })
    );
    return;
  }
  if (process.env.INPUTS_ACTION === 'prepare') {
    const candidate = candidateSchema.parse(input('CANDIDATE'));
    if (!candidate.delivered) {
      console.log(
        JSON.stringify({
          available: false,
          input: null,
          report_path: '',
          summary: 'no delivered candidate',
          references: [],
        })
      );
      return;
    }
    const facts = await collectMergeFacts(candidate.prs, adapter);
    const runtime = input('RUNTIME');
    const holdout = input('HOLDOUT');
    const directory = join(artifacts, 'qualified-evidence', randomUUID());
    const workflowDir = dirname(dirname(script));
    let bundle = null;
    let structuralError = '';
    try {
      bundle = await prepareQualification({
        checkout: process.cwd(),
        runId: z.string().min(1).parse(process.env.WORKFLOW_ID),
        artifactsDir: artifacts,
        expected,
        facts,
        runtime,
        holdout,
        evaluator: [
          script,
          join(workflowDir, 'commands/qualify-runtime.md'),
          join(workflowDir, 'archon-lifecycle.yaml'),
        ],
      });
      if (bundle.source.head !== candidate.head) throw new Error('delivered candidate changed');
    } catch (error) {
      bundle = null;
      structuralError = error instanceof Error ? error.message : String(error);
    }
    let repairEvidence: z.infer<typeof repairEvidenceSchema> | null = null;
    for (const [result, scenario] of [
      [runtime, expected.scenario],
      [holdout, expected.holdout],
    ] as const) {
      const parsed = runtimeResultSchema.safeParse(result);
      if (!parsed.success || parsed.data.verdict !== 'failed') continue;
      try {
        await checkRuntime(parsed.data, await realpath(scenario), candidate.head);
        if (
          parsed.data.evidence.producer.runId === process.env.WORKFLOW_ID &&
          cleanQualificationHead(process.cwd()) === candidate.head &&
          facts.pullRequests.length === 1 &&
          facts.pullRequests[0]?.headSha === candidate.head
        )
          repairEvidence = {
            runtime: parsed.data,
            scenario: await realpath(scenario),
            head: candidate.head,
          };
      } catch (error) {
        structuralError ||= error instanceof Error ? error.message : String(error);
      }
    }
    const reference = await writeEvidence(join(directory, 'input.json'), {
      bundle,
      facts,
      candidate,
      runtime,
      holdout,
      repairEvidence,
      requirements: expected,
      structuralError,
      sourceFingerprint: validationFingerprint(),
    });
    console.log(
      JSON.stringify({
        available: true,
        input: reference,
        report_path: join(directory, 'qualification.md'),
        summary: structuralError || 'evidence ready for semantic qualification',
        references: [],
      })
    );
    return;
  }
  if (process.env.INPUTS_ACTION !== 'seal') throw new Error('unsupported qualification action');
  const prepared = preparedSchema.parse(input('PREPARED'));
  const held = (
    summary: string,
    evidence = '',
    repair = false,
    holds: Hold[] = [{ kind: 'evidence', reason: summary }]
  ): z.infer<typeof qualificationResultSchema> => ({
    ready: false,
    repair,
    evidence,
    references: [],
    summary,
    holds,
  });
  if (!prepared.available && prepared.references.length > 0) {
    console.log(
      JSON.stringify({
        ready: true,
        repair: false,
        evidence: '',
        references: prepared.references,
        summary: prepared.summary,
        holds: [],
      })
    );
    return;
  }
  if (!prepared.available || prepared.input === null) {
    console.log(JSON.stringify(held(prepared.summary)));
    return;
  }
  const stored = z
    .object({
      bundle: qualificationBundleSchema.nullable(),
      repairEvidence: repairEvidenceSchema.nullable(),
      requirements: qualificationRequirementsSchema,
      facts: z.unknown(),
      sourceFingerprint: z.string(),
    })
    .parse(JSON.parse((await readEvidence(prepared.input)).toString()) as unknown);
  if (!isFacts(stored.facts)) throw new Error('qualification facts are malformed');
  const decision = qualificationDecisionSchema.parse(input('DECISION'));
  if ((await realpath(decision.evidence)) !== (await realpath(prepared.report_path)))
    throw new Error('qualification report must use its prepared path');
  if ((await readFile(prepared.report_path, 'utf8')).trim() === '')
    throw new Error('qualification report is empty');
  const facts = await collectMergeFacts(
    stored.facts.pullRequests.map(pull => pull.url),
    adapter
  );
  if (
    JSON.stringify(expected) !== JSON.stringify(stored.requirements) ||
    validationFingerprint() !== stored.sourceFingerprint ||
    stored.facts.pullRequests.some(pr => {
      const current = facts.pullRequests.find(pull => pull.url === pr.url);
      return (
        current?.headSha !== pr.headSha ||
        current.base !== pr.base ||
        current.liveBaseSha !== pr.liveBaseSha ||
        current.reviewFingerprint !== pr.reviewFingerprint
      );
    })
  ) {
    console.log(
      JSON.stringify(
        held(
          'qualification inputs, source, candidate, base or review changed during qualification',
          decision.evidence
        )
      )
    );
    return;
  }
  if (!decision.ready) {
    let repair = false;
    if (
      decision.repair &&
      stored.repairEvidence !== null &&
      decision.holds.some(hold => hold.kind === 'code')
    ) {
      try {
        const evidence = stored.repairEvidence;
        if (cleanQualificationHead(process.cwd()) !== evidence.head)
          throw new Error('repair checkout changed');
        await checkRuntime(evidence.runtime, evidence.scenario, evidence.head);
        for (const reference of decision.supporting_evidence) await readEvidence(reference);
        repair = true;
      } catch (error) {
        console.log(
          JSON.stringify(
            held(error instanceof Error ? error.message : String(error), decision.evidence)
          )
        );
        return;
      }
    }
    console.log(
      JSON.stringify(
        held(
          decision.summary,
          decision.evidence,
          repair,
          decision.holds.length ? decision.holds : undefined
        )
      )
    );
    return;
  }
  if (stored.bundle === null) {
    console.log(
      JSON.stringify(
        held('semantic readiness cannot replace incomplete evidence', decision.evidence)
      )
    );
    return;
  }
  try {
    const reference = await sealQualification(
      stored.bundle,
      decision,
      expected,
      facts,
      join(dirname(prepared.input.path), 'qualified.json')
    );
    console.log(
      JSON.stringify({
        ready: true,
        repair: false,
        evidence: decision.evidence,
        references: [reference],
        summary: decision.summary,
        holds: [],
      })
    );
  } catch (error) {
    console.log(
      JSON.stringify(
        held(error instanceof Error ? error.message : String(error), decision.evidence)
      )
    );
  }
}
