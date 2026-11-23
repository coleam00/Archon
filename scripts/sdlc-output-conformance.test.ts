/**
 * The SDLC pack's outputs, read on the engine's terms. The pack may not import engine code,
 * so its tests cannot ask the engine whether a script's stdout passes the node's declared
 * `output_format`, or whether a value the pack restates (a status set, a tier name, a node
 * id the engine derives) still matches. These tests run the pack's scripts and parse its
 * workflows, then judge the result with the engine's own validator, schemas and naming.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { workflowRunStatusSchema } from '../packages/workflows/src/schemas/run-status';
import { isStateLeaseHolderLive } from '../packages/workflows/src/state-document-store';
import { validateStructuredOutput } from '../packages/workflows/src/structured-output';
import { fakeLeaseLive } from '../.archon/scripts/__tests__/fixtures/fake-lease';
import { PACK, PR } from '../.archon/scripts/__tests__/deliver-checks-harness';
import type { Closure } from '../.archon/workflows/sdlc/.shared/close';
import { parseQualifiedPr } from '../.archon/workflows/sdlc/.shared/identity';
import { SIZE_LABEL, TYPE_LABEL } from '../.archon/workflows/sdlc/.shared/labels';

registerBuiltinProviders();

type Schema = Record<string, unknown>;

/** The `output_format` a pack workflow declares on one node, as the engine validates it. */
function outputFormat(workflow: string, nodeId: string): Schema {
  const parsed = Bun.YAML.parse(readFileSync(join(PACK, workflow), 'utf8')) as {
    nodes: { id: string; output_format?: Schema }[];
  };
  const schema = parsed.nodes.find(node => node.id === nodeId)?.output_format;
  if (schema === undefined) throw new Error(`${workflow} declares no output_format on ${nodeId}`);
  return schema;
}

describe('triage', () => {
  const TRIAGE = 'triage/archon-triage-block.yaml';
  const DELIVERED: Closure = {
    kind: 'delivered',
    url: 'https://ghe.example.com/example/repo/pull/5',
  };

  const VALID = {
    decision: { contract: 'READY', route: 'deliver' },
    type: { value: 'bug', reason: 'a regression' },
    size: { value: 's', reason: 'one file' },
    complexity: { value: 'high', reason: 'touches authentication' },
    importance: { value: 'medium', reason: 'on direction' },
    urgency: { value: 'now', reason: 'blocks a release' },
    item: { repo: { host: '', path: '' }, number: 0 },
    area_labels: [],
    related: [],
    summary: 'Ready',
    report: { type: 'archon_artifact', run_id: 'r', path: 'triage.md' },
  };

  test('the triage schema requires the kind and URL on NO_ACTION, so the provider is re-asked', () => {
    const schema = outputFormat(TRIAGE, 'triage');
    const declared = (decision: unknown) =>
      validateStructuredOutput({ ...VALID, decision, item: { repo: PR.repo, number: 7 } }, schema)
        .valid;
    const original = { repo: PR.repo, number: 3 };
    const url = 'https://ghe.example.com/example/repo/issues/3';
    expect(declared({ contract: 'NO_ACTION', closure: DELIVERED })).toBe(true);
    expect(declared({ contract: 'NO_ACTION', closure: { kind: 'duplicate', url, original } })).toBe(
      true
    );
    for (const closure of [
      undefined,
      { url },
      { kind: 'delivered' },
      { kind: 'duplicate', url },
      { kind: 'obsolete', url },
    ]) {
      expect(declared({ contract: 'NO_ACTION', closure })).toBe(false);
    }
  });

  test('the triage producer declares qualified identities and its non-tracker sentinel', () => {
    const schema = (outputFormat(TRIAGE, 'triage').properties as Record<string, Schema>).item;
    const qualified = { repo: { host: 'tracker.example', path: 'group/team/repo' }, number: 7 };
    expect(validateStructuredOutput(qualified, schema).valid).toBe(true);
    expect(
      validateStructuredOutput({ repo: { host: '', path: '' }, number: 0 }, schema).valid
    ).toBe(true);
    expect(validateStructuredOutput({ repository: 'owner/repo', number: 7 }, schema).valid).toBe(
      false
    );
    expect(
      validateStructuredOutput({ repo: { path: 'group/team/repo' }, number: 7 }, schema).valid
    ).toBe(false);
    // Half-qualified or mismatched pairings are re-asked at the node, never refused later.
    for (const illegal of [
      { repo: { host: '', path: 'group/team/repo' }, number: 7 },
      { repo: { host: 'tracker.example', path: 'group/team/repo' }, number: 0 },
      { repo: { host: '', path: '' }, number: 7 },
      { repo: { host: ' ', path: 'group/team/repo' }, number: 7 },
    ]) {
      expect(validateStructuredOutput(illegal, schema).valid).toBe(false);
    }
  });

  test('triage requires its five judged fields, each a listed value and a non-empty reason', () => {
    const schema = outputFormat(TRIAGE, 'triage');
    expect(validateStructuredOutput(VALID, schema).valid).toBe(true);
    // An invalid output is what the engine re-asks the provider on.
    for (const field of ['type', 'size', 'complexity', 'importance', 'urgency'] as const) {
      const { [field]: judged, ...missing } = VALID;
      expect(validateStructuredOutput(missing, schema).valid).toBe(false);
      for (const broken of [
        { value: judged.value },
        { value: judged.value, reason: ' ' },
        { value: 'small', reason: 'retired value' },
      ]) {
        expect(validateStructuredOutput({ ...VALID, [field]: broken }, schema).valid).toBe(false);
      }
    }
    // The labels mirror type and size, so the schema's values and the label map's keys
    // must be the same set.
    const properties = schema.properties as Record<
      string,
      { properties: { value: { enum: string[] } } }
    >;
    expect([...properties.type.properties.value.enum].sort()).toEqual(
      Object.keys(TYPE_LABEL).sort()
    );
    expect([...properties.size.properties.value.enum].sort()).toEqual(
      Object.keys(SIZE_LABEL).sort()
    );
  });
});

// archon-review's scope node declares the pull request that publish-review then hands to
// parseQualifiedPr. A value the schema admits but the parser refuses passes the provider's
// structured output and fails publication after the whole review ran.
test("archon-review's scope pr schema admits exactly what parseQualifiedPr accepts", () => {
  const schema = outputFormat('review/archon-review.yaml', 'scope');
  const repo = { host: 'github.com', path: 'coleam00/Archon' };
  const report = { type: 'archon_artifact', run_id: 'run', path: 'review/scope.md' };
  const candidates = [
    { repo, number: 1 },
    { repo, number: 0 },
    { repo, number: -3 },
    { repo: { ...repo, host: '' }, number: 1 },
    { repo: { ...repo, host: '  ' }, number: 1 },
    { repo: { ...repo, path: '' }, number: 1 },
    { repo: { ...repo, path: '\t' }, number: 1 },
  ];
  const verdicts = candidates.map(pr => {
    let parserAccepts = true;
    try {
      parseQualifiedPr(JSON.stringify(pr));
    } catch {
      parserAccepts = false;
    }
    return {
      parserAccepts,
      schemaAccepts: validateStructuredOutput({ pr, report }, schema).valid,
    };
  });
  expect(verdicts.map(v => v.schemaAccepts)).toEqual(verdicts.map(v => v.parserAccepts));
  // Guard against a vacuous match: the parser must accept the qualified PR.
  expect(verdicts[0]?.parserAccepts).toBe(true);
});

describe('claims', () => {
  test("the test CLI's lease liveness is the engine's", () => {
    for (const status of workflowRunStatusSchema.options)
      expect(fakeLeaseLive(status)).toBe(isStateLeaseHolderLive(status));
    // A run the store no longer has: deleted, so its lease has ended.
    expect(fakeLeaseLive(undefined)).toBe(isStateLeaseHolderLive(null));
  });
});
