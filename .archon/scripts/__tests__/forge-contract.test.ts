import { providerRegistry } from '@archon/providers';
import { expect, test } from 'bun:test';
import {
  forgeErrorSchema,
  forgeRequestSchema,
  type ForgeRequest,
  type ForgeResponse,
  type ForgeMutationFailure,
} from '../../../packages/forge/src/operations';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateStructuredOutput } from '../../../packages/workflows/src/structured-output';
import { parseWorkflow } from '../../../packages/workflows/src/loader';
import {
  FORGE_SOURCES,
  record,
  parseQualifiedPr,
  REMEDY,
  type PrRecord,
  type QualifiedPr,
  type MergeRequest,
  type MergeResult,
  type ReviewsResult,
  type MutationFailure,
} from '../../workflows/sdlc/.shared/forge';
import { SIZE_LABEL, TYPE_LABEL } from '../../workflows/sdlc/.shared/labels';
import type { PrRef } from '../../../packages/forge/src/identity';
import {
  closeReasonSchema,
  forgePrRecordSchema,
  type ForgePrRecord,
} from '../../../packages/forge/src/lifecycle';
import { CLOSE_REASONS } from '../../workflows/sdlc/.shared/issue';

// The pack is standalone and cannot import runtime packages. These assignments
// check that its consumed projection stays compatible with the owning wire type.
const consumesPr = (value: PrRef): QualifiedPr => value;
const producesPr = (value: QualifiedPr): PrRef => value;
const consumesPrRecord = (value: ForgePrRecord): PrRecord => value;
const producesPrRecord = (value: PrRecord): ForgePrRecord => value;

test('standalone pack consumes the owning qualified identity and pull-request record', () => {
  const ref = { repo: { host: 'forge.example', path: 'group/team/repo' }, number: 42 };
  expect(producesPr(consumesPr(ref))).toEqual(ref);

  // parsePrRecord validates every pull-request result the pack's write nodes
  // read, so a field the owning schema grows must reach it or the pack starts
  // rejecting records @archon/forge produced.
  const pr: ForgePrRecord = forgePrRecordSchema.parse({
    schemaVersion: 1,
    repo: ref.repo,
    number: ref.number,
    url: 'https://forge.example/group/team/repo/pull/42',
    head: 'feature',
    base: 'dev',
    is_draft: true,
    state: 'open',
    head_repo: ref.repo,
    head_revision: 'headsha',
    base_revision: 'basesha',
    maintainer_can_modify: null,
  });
  expect(producesPrRecord(consumesPrRecord(pr))).toEqual(pr);
});

// A remedy keyed by a kind the contract no longer names would never be shown.
test("every refusal remedy is keyed by a kind the forge contract's errors carry", () => {
  expect(forgeErrorSchema.shape.kind.options).toEqual(
    expect.arrayContaining(Object.keys(REMEDY))
  );
});

// archon-review's scope node declares the pull request that publish-review then
// hands to parseQualifiedPr. A value the schema admits but the parser refuses
// passes the provider's structured output and fails publication after the whole
// review ran, so the two must accept the same values.
test('every reason the pack closes an issue with is a forge close reason', () => {
  for (const reason of CLOSE_REASONS) expect(closeReasonSchema.parse(reason)).toBe(reason);
});

test("archon-review's scope pr schema admits exactly what parseQualifiedPr accepts", () => {
  const file = join(import.meta.dir, '../../workflows/sdlc/review/archon-review-block.yaml');
  const parsed = parseWorkflow(readFileSync(file, 'utf8'), 'archon-review-block.yaml', providerRegistry);
  if (parsed.workflow === null) throw new Error(parsed.error.error);
  const scope = parsed.workflow.nodes.find(node => node.id === 'scope');
  if (scope === undefined || !('output_format' in scope) || scope.output_format === undefined) {
    throw new Error('archon-review has no scope node with an output_format');
  }
  const schema = scope.output_format;

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
      pr,
      parserAccepts,
      schemaAccepts: validateStructuredOutput({ head_matches: true, pr, report }, schema).valid,
    };
  });

  expect(verdicts.map(v => v.schemaAccepts)).toEqual(verdicts.map(v => v.parserAccepts));
  // Guard against a vacuous match: the parser must accept the qualified PR.
  expect(verdicts[0].parserAccepts).toBe(true);
});

test('triage producer declares qualified identities and its non-tracker sentinel', () => {
  const file = join(import.meta.dir, '../../workflows/sdlc/triage/archon-triage-block.yaml');
  const parsed = parseWorkflow(readFileSync(file, 'utf8'), 'archon-triage-block.yaml', providerRegistry);
  if (parsed.workflow === null) throw new Error(parsed.error.error);
  const node = parsed.workflow.nodes.find(node => node.id === 'triage');
  if (!node || !('output_format' in node) || !node.output_format)
    throw new Error('missing triage schema');
  const schema = (node.output_format.properties as Record<string, Record<string, unknown>>).item;
  const qualified = { repo: { host: 'tracker.example', path: 'group/team/repo' }, number: 7 };
  expect(validateStructuredOutput(qualified, schema).valid).toBe(true);
  expect(validateStructuredOutput({ repo: { host: '', path: '' }, number: 0 }, schema).valid).toBe(
    true
  );
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
  const file = join(import.meta.dir, '../../workflows/sdlc/triage/archon-triage-block.yaml');
  const parsed = parseWorkflow(readFileSync(file, 'utf8'), 'archon-triage-block.yaml', providerRegistry);
  if (parsed.workflow === null) throw new Error(parsed.error.error);
  const node = parsed.workflow.nodes.find(node => node.id === 'triage');
  if (!node || !('output_format' in node) || !node.output_format)
    throw new Error('missing triage schema');
  const schema = node.output_format;
  const valid = {
    decision: { contract: 'READY', route: 'deliver' },
    type: { value: 'bug', reason: 'a regression' },
    size: { value: 's', reason: 'one file' },
    complexity: { value: 'high', reason: 'touches authentication' },
    importance: { value: 'medium', reason: 'on direction' },
    urgency: { value: 'now', reason: 'blocks a release' },
    item: { repo: { host: '', path: '' }, number: 0 },
    area_labels: [],
    summary: 'Ready',
    report: { type: 'archon_artifact', run_id: 'r', path: 'triage.md' },
  };
  expect(validateStructuredOutput(valid, schema).valid).toBe(true);
  // An invalid output is what the engine re-asks the provider on.
  for (const field of ['type', 'size', 'complexity', 'importance', 'urgency'] as const) {
    const { [field]: judged, ...missing } = valid;
    expect(validateStructuredOutput(missing, schema).valid).toBe(false);
    for (const broken of [
      { value: judged.value },
      { value: judged.value, reason: ' ' },
      { value: 'small', reason: 'retired value' },
    ]) {
      expect(validateStructuredOutput({ ...valid, [field]: broken }, schema).valid).toBe(false);
    }
  }
  // The labels mirror type and size, so the schema's values and the label map's keys
  // must be the same set.
  const properties = schema.properties as Record<
    string,
    { properties: { value: { enum: string[] } } }
  >;
  expect([...properties.type.properties.value.enum].sort()).toEqual(Object.keys(TYPE_LABEL).sort());
  expect([...properties.size.properties.value.enum].sort()).toEqual(Object.keys(SIZE_LABEL).sort());
});

type ContractResult = Extract<ForgeResponse, { ok: true }>['result'];
const consumesMerge = (value: Extract<ContractResult, { op: 'pr.merge' }>): MergeResult =>
  value.value;
const consumesReviews = (value: Extract<ContractResult, { op: 'pr.reviews' }>): ReviewsResult =>
  value.value;
const consumesFailure = (value: ForgeMutationFailure): MutationFailure => value;
const producesMerge = (
  value: MergeRequest
): Omit<Extract<ForgeRequest, { op: 'pr.merge' }>, 'op' | 'operationId'> => value;

test('standalone new-operation projections carry typed request and result evidence', async () => {
  const { forgeRequestSchema } = await import('../../../packages/forge/src/operations');
  const ref = { repo: { host: 'forge.example', path: 'group/repo' }, number: 1 };
  expect(
    forgeRequestSchema.parse({
      ...producesMerge({ ref, method: 'merge', conditions: { head: 'opaque-head' } }),
      op: 'pr.merge',
      operationId: 'merge',
    }).op
  ).toBe('pr.merge');
  expect(consumesReviews({ op: 'pr.reviews', value: { ref, items: [] } })).toEqual({
    ref,
    items: [],
  });
  expect(
    consumesFailure({
      op: 'pr.merge',
      target: ref,
      outcome: 'outcome_unknown',
      merge: { method: 'merge', conditions: { head: 'head' } },
    }).outcome
  ).toBe('outcome_unknown');
  const pr = forgePrRecordSchema.parse({
    ...ref,
    schemaVersion: 1,
    url: 'https://forge.example/pr/1',
    head: 'feature',
    base: 'dev',
    is_draft: false,
    state: 'merged',
    head_repo: ref.repo,
    head_revision: 'head',
    base_revision: null,
    maintainer_can_modify: null,
  });
  expect(
    consumesMerge({
      op: 'pr.merge',
      value: {
        target: ref,
        outcome: 'applied',
        changed: true,
        pr,
        method: 'squash',
        conditions: { head: 'head' },
        enforcedConditions: ['head'],
        landed: { commit: 'landed', tree: null, parents: null },
      },
    }).landed.commit
  ).toBe('landed');
});

test('all four preflight source validators conform to the pack source selector', () => {
  for (const folder of ['deliver', 'pr', 'ship', 'upkeep']) {
    const file = `archon-${folder}${folder === 'deliver' || folder === 'ship' ? '-block' : ''}.yaml`;
    const parsed = parseWorkflow(readFileSync(join(import.meta.dir, `../../workflows/sdlc/${folder}/${file}`), 'utf8'), file, providerRegistry);
    if (!parsed.workflow) throw new Error('invalid preflight workflow');
    const first = parsed.workflow.nodes[0];
    if (!first || !('output_format' in first)) throw new Error('missing preflight schema');
    expect(record(record(first.output_format?.properties)?.source)?.enum).toEqual(FORGE_SOURCES);
  }
});

test('every node of the four preflighted flows runs after the forge check', () => {
  for (const folder of ['deliver', 'pr', 'ship', 'upkeep']) {
    const file = `archon-${folder}${folder === 'deliver' || folder === 'ship' ? '-block' : ''}.yaml`;
    const parsed = parseWorkflow(readFileSync(join(import.meta.dir, `../../workflows/sdlc/${folder}/${file}`), 'utf8'), file, providerRegistry);
    if (!parsed.workflow) throw new Error(`invalid workflow ${file}`);
    const dependsOn = new Map(parsed.workflow.nodes.map(node => [node.id, node.depends_on ?? []]));
    const afterForge = (id: string): boolean =>
      (dependsOn.get(id) ?? []).some(dep => dep === 'forge' || afterForge(dep));
    const early = [...dependsOn.keys()].filter(id => id !== 'forge' && !afterForge(id));
    expect({ file, early }).toEqual({ file, early: [] });
  }
});

test('operator guidance describes the gh default and forge host login source', () => {
  const root = join(import.meta.dir, '../../..');
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('## [')[1] ?? '';
  const docker = readFileSync(join(root, 'packages/docs-web/src/content/docs/deployment/docker.md'), 'utf8');
  expect(changelog.includes('forge path does not read your `gh` login')).toBe(false);
  expect(docker.includes('read this login only when')).toBe(false);
});

test('both onboarding guides explain the default and compatible forge opt-in', () => {
  for (const guide of ['getting-started/quick-start.md', 'book/first-five-minutes.md']) {
    const text = readFileSync(
      join(import.meta.dir, '../../../packages/docs-web/src/content/docs', guide),
      'utf8'
    );
    expect(text).toContain('GitHub CLI (`gh`) by default');
    expect(text).toContain('`ARCHON_SDLC_FORGE=forge`');
    expect(text).toContain('compatible plugin');
  }
});

test('preflight capabilities cover concrete pack calls and agent command instructions', async () => {
  const { REQUIRED_FORGE_OPERATIONS } = await import('../../workflows/sdlc/.shared/forge-check');
  const root = join(import.meta.dir, '../../workflows/sdlc');
  const sources = [...new Bun.Glob('**/*.{ts,md}').scanSync({ cwd: root, dot: true })]
    .filter(file => file !== '.shared/forge-check.ts')
    .map(file => readFileSync(join(root, file), 'utf8'));
  const used = forgeRequestSchema.options
    .map(schema => schema.shape.op.value)
    .filter(op =>
      sources.some(text =>
        ["'" + op + "'", '"' + op + '"', '`' + op + '`', 'forge ' + op + ' '].some(
          token => text.includes(token)
        )
      )
    );
  expect(used).toContain('checks.state');
  expect(used.sort()).toEqual([...REQUIRED_FORGE_OPERATIONS].sort());
});

test('standalone host response projection preserves credential attribution and metadata', async () => {
  const { cliForgeResponseSchema, cliForgeMetadataRequestSchema } =
    await import('../../../packages/forge/src/cli-response');
  const { forgeResult } = await import('../../workflows/sdlc/.shared/forge');
  const metadata = {
    protocol: 1,
    name: 'github',
    version: 'test',
    forge: 'github',
    hosts: ['github.com'],
    capabilities: ['pr.view'],
    token_env: ['GH_TOKEN'],
  };
  const request = cliForgeMetadataRequestSchema.parse({
    operationId: 'meta',
    op: 'metadata',
    host: 'github.com',
  });
  const response = cliForgeResponseSchema.parse({
    operationId: request.operationId,
    ok: true,
    result: { op: request.op, value: metadata },
  });
  expect(forgeResult(request.op, response, 0)).toEqual(metadata);
  for (const ok of [true, false]) {
    const response = cliForgeResponseSchema.parse({
      operationId: 'read',
      ok,
      credentialSource: 'GH_TOKEN',
      ...(ok
        ? { result: { op: 'pr.view', value: null } }
        : { error: { kind: 'authorization', message: 'Rejected' } }),
    });
    let source: string | undefined;
    const read = () =>
      forgeResult('pr.view', response, ok ? 0 : 1, value => {
        source = value;
      });
    if (ok) expect(read()).toBeNull();
    else expect(read).toThrow('source: GH_TOKEN');
    expect(source).toBe('GH_TOKEN');
  }
});
