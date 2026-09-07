import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const admissionValues = {
  disposition: ['accepted', 'deferred', 'rejected', 'needs-human'],
  priority: ['high', 'medium', 'low'],
  route: ['investigate', 'plan', 'deliver', 'no_action'],
} as const;

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a nonempty string`);
  }
  return value;
}

function strings(value: unknown, field: string, nonempty = false): string[] {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) {
    throw new Error(`${field} must be ${nonempty ? 'a nonempty' : 'an'} array`);
  }
  return value.map((item: unknown) => text(item, field));
}

function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  const selected = choices.find(candidate => candidate === value);
  if (selected === undefined) throw new Error(`${field} has an unsupported value`);
  return selected;
}

function exactKeys(value: Record<string, unknown>, expected: object, field: string): void {
  if (Object.keys(value).some(key => !Object.hasOwn(expected, key))) {
    throw new Error(`${field} contains undeclared fields`);
  }
}

export function validateJudgment(value: unknown) {
  const judgment = record(value, 'judgment');
  const raw = record(judgment.decision, 'decision');
  const decision = {
    disposition: choice(raw.disposition, admissionValues.disposition, 'disposition'),
    priority: choice(raw.priority, admissionValues.priority, 'priority'),
    route: choice(raw.route, admissionValues.route, 'route'),
    summary: text(raw.summary, 'summary'),
    assumptions: strings(raw.assumptions, 'assumptions'),
    rules_cited: strings(raw.rules_cited, 'rules_cited', true),
  };
  exactKeys(raw, decision, 'decision');
  const admitted = decision.disposition === 'accepted';
  const actionable = decision.route !== 'no_action';
  if (admitted !== actionable) {
    throw new Error('Only accepted work may have an engineering route; refusals require no_action');
  }
  const result = { decision, evidence: strings(judgment.evidence, 'evidence', true) };
  exactKeys(judgment, result, 'judgment');
  return result;
}

export async function writeAdmission(artifactsDir: string, judgment: unknown, triage: unknown) {
  text(artifactsDir, 'ARTIFACTS_DIR');
  const { decision, evidence } = validateJudgment(judgment);
  const rawTriage = record(triage, 'triage');
  const grounding = {
    route: choice(rawTriage.route, admissionValues.route, 'triage.route'),
    summary: text(rawTriage.summary, 'triage.summary'),
  };
  const bullets = (items: string[]): string => items.map(item => `- ${item}`).join('\n');
  const report = [
    '# Admission',
    `Disposition: ${decision.disposition}\nPriority: ${decision.priority}\nRoute: ${decision.route}`,
    decision.summary,
    '## Rules cited',
    bullets(decision.rules_cited),
    '## Decision evidence',
    bullets(evidence),
    '## Assumptions',
    decision.assumptions.length ? bullets(decision.assumptions) : 'None.',
    '## Grounding',
    `Triage route: ${grounding.route}\n\n${grounding.summary}\n\nFull grounding: triage.md`,
  ].join('\n\n');
  await writeFile(join(artifactsDir, 'admission.md'), `${report}\n`, 'utf8');
  await writeFile(
    join(artifactsDir, 'admission.json'),
    `${JSON.stringify({ ...decision, evidence, grounding }, null, 2)}\n`,
    'utf8'
  );
  return decision;
}

if (import.meta.main) {
  try {
    const decision = await writeAdmission(
      process.env.ARTIFACTS_DIR ?? '',
      JSON.parse(process.env.INPUTS_JUDGMENT ?? ''),
      JSON.parse(process.env.INPUTS_TRIAGE ?? '')
    );
    console.log(JSON.stringify(decision));
  } catch (error) {
    // JSON syntax errors may contain the input, which can include private task text.
    console.error(error instanceof SyntaxError ? 'Invalid admission input JSON' : String(error));
    process.exitCode = 1;
  }
}
