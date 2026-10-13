import { providerRegistry } from '@archon/providers';
import { expect, test } from 'bun:test';
import {
  checksStateSchema,
  concludedCheckStates,
  type ChecksObservation as ContractObservation,
  type ForgeRequest,
  type ForgeResponse,
  type ForgeMutationFailure,
} from '../../../packages/forge/src/operations';
import { checkResultSchema } from '../../../packages/forge/src/events';
import { handleGithubOperation } from '../../../packages/adapters/src/forge/github/operations';
import { ghCheckUnit } from '../../workflows/sdlc/.shared/checks';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateStructuredOutput } from '../../../packages/workflows/src/structured-output';
import { parseWorkflow } from '../../../packages/workflows/src/loader';
import {
  CHECK_STATES,
  CONCLUDED_CHECK_STATES,
  type ChecksObservation as PackObservation,
  parseQualifiedPr,
  parseCreatedWorkItem,
  type PrRecord,
  type QualifiedPr,
  type MergeRequest,
  type MergeResult,
  type RerunRequest,
  type RerunResult,
  type ReviewsResult,
  type MutationFailure,
} from '../../workflows/sdlc/.shared/forge';
import type { PrRef } from '../../../packages/forge/src/identity';
import {
  forgePrRecordSchema,
  type ForgePrRecord,
  type ForgeWorkItemRecord,
} from '../../../packages/forge/src/lifecycle';

// The pack is standalone and cannot import runtime packages. These assignments
// check that its consumed projection stays compatible with the owning wire type.
const consumesObservation = (value: ContractObservation): PackObservation => value;
const consumesPr = (value: PrRef): QualifiedPr => value;
const producesPr = (value: QualifiedPr): PrRef => value;
const consumesPrRecord = (value: ForgePrRecord): PrRecord => value;
const producesPrRecord = (value: PrRecord): ForgePrRecord => value;

test('standalone pack consumes the owning forge vocabulary and qualified identity', () => {
  expect([...CHECK_STATES]).toEqual(checksStateSchema.options);
  const ref = { repo: { host: 'forge.example', path: 'group/team/repo' }, number: 42 };
  expect(producesPr(consumesPr(ref))).toEqual(ref);
  const observation: ContractObservation = {
    ref,
    revision: 'opaque-object-id',
    units: [],
    required: null,
    summary: {
      state: 'none',
      counts: { total: 0, green: 0, red: 0, pending: 0, gated: 0, unknown: 0 },
    },
  };
  expect(consumesObservation(observation)).toBe(observation);

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

// The deliver pack reads GitHub checks through gh by default and through the
// GitHub forge plugin on opt-in; both must gate every result the same way.
test('gh and the GitHub forge plugin classify every GitHub check result identically', async () => {
  expect(CONCLUDED_CHECK_STATES).toEqual(concludedCheckStates);

  // Every result the forge vocabulary names, plus one GitHub has not shipped yet.
  const conclusions = [
    ...checkResultSchema.options.filter(result => result !== 'unknown'),
    'brand_new',
  ];
  const statuses = ['success', 'failure', 'error', 'pending'];
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith('/pulls/42')) return Response.json({ head: { sha: 'head' } });
    if (url.includes('/actions/runs')) return Response.json({ total_count: 0, workflow_runs: [] });
    if (url.includes('/check-runs')) {
      return Response.json({
        check_runs: [
          ...conclusions.map((conclusion, id) => ({
            id,
            name: conclusion,
            status: 'completed',
            conclusion,
          })),
          { id: 100, name: 'queued', status: 'queued', conclusion: null },
          { id: 101, name: 'in_progress', status: 'in_progress', conclusion: null },
        ],
      });
    }
    if (url.includes('/statuses')) {
      return Response.json(
        statuses.map((state, id) => ({ id, context: `status-${state}`, state }))
      );
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const response = await handleGithubOperation(
    {
      operationId: 'agreement',
      op: 'checks.state',
      ref: { repo: { host: 'github.com', path: 'owner/repo' }, number: 42 },
    },
    { token: 'token', fetch }
  );
  if (!response.ok || response.result.op !== 'checks.state') throw new Error('expected checks');
  const forge = Object.fromEntries(
    response.result.value.units.map(unit => [unit.unit.name, unit.state])
  );

  // gh's `state` is a check run's conclusion once it completes, its status
  // before that, and a commit status's own state, all upper-cased.
  const gh = Object.fromEntries([
    ...[...conclusions, 'queued', 'in_progress'].map(name => [
      name,
      ghCheckUnit({ name, state: name.toUpperCase() }).state,
    ]),
    ...statuses.map(state => [
      `status-${state}`,
      ghCheckUnit({ name: state, state: state.toUpperCase() }).state,
    ]),
  ]);
  expect(Object.keys(forge)).toHaveLength(conclusions.length + 2 + statuses.length);
  expect(gh).toEqual(forge);
  expect(gh).toMatchObject({
    action_required: 'gated',
    stale: 'red',
    startup_failure: 'red',
    brand_new: 'unknown',
  });
});

// archon-review's scope node declares the pull request that publish-review then
// hands to parseQualifiedPr. A value the schema admits but the parser refuses
// passes the provider's structured output and fails publication after the whole
// review ran, so the two must accept the same values.
test("archon-review's scope pr schema admits exactly what parseQualifiedPr accepts", () => {
  const file = join(import.meta.dir, '../../workflows/sdlc/review/archon-review.yaml');
  const parsed = parseWorkflow(readFileSync(file, 'utf8'), 'archon-review.yaml', providerRegistry);
  if (parsed.workflow === null) throw new Error(parsed.error.error);
  const scope = parsed.workflow.nodes.find(node => node.id === 'scope');
  if (scope === undefined || !('output_format' in scope) || scope.output_format === undefined) {
    throw new Error('archon-review has no scope node with an output_format');
  }
  const schema = scope.output_format;

  const repo = { host: 'github.com', path: 'coleam00/Archon' };
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
      schemaAccepts: validateStructuredOutput({ docs: false, pr }, schema).valid,
    };
  });

  expect(verdicts.map(v => v.schemaAccepts)).toEqual(verdicts.map(v => v.parserAccepts));
  // Guard against a vacuous match: the parser must accept the qualified PR.
  expect(verdicts[0].parserAccepts).toBe(true);
});

test('standalone work-item projection accepts the owning identity and rejects a foreign repository', () => {
  const repo = { host: 'tracker.example', path: 'group/team/repo' };
  const workitem: ForgeWorkItemRecord = {
    ref: { repo, number: 1 },
    kind: 'issue',
    url: 'https://tracker.example/group/team/repo/items/1',
    state: 'closed',
  };
  const value = { outcome: 'applied', changed: false, workitem };
  expect(parseCreatedWorkItem(value, repo)).toBe(workitem.url);
  expect(() => parseCreatedWorkItem(value, { ...repo, path: 'other' })).toThrow();
});

test('triage producer declares qualified identities and its non-tracker sentinel', () => {
  const file = join(import.meta.dir, '../../workflows/sdlc/triage/archon-triage.yaml');
  const parsed = parseWorkflow(readFileSync(file, 'utf8'), 'archon-triage.yaml', providerRegistry);
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
});

type ContractResult = Extract<ForgeResponse, { ok: true }>['result'];
const consumesMerge = (value: Extract<ContractResult, { op: 'pr.merge' }>): MergeResult =>
  value.value;
const consumesRerun = (value: Extract<ContractResult, { op: 'checks.rerun' }>): RerunResult =>
  value.value;
const consumesReviews = (value: Extract<ContractResult, { op: 'pr.reviews' }>): ReviewsResult =>
  value.value;
const consumesFailure = (value: ForgeMutationFailure): MutationFailure => value;
const producesMerge = (
  value: MergeRequest
): Omit<Extract<ForgeRequest, { op: 'pr.merge' }>, 'op' | 'operationId'> => value;
const producesRerun = (
  value: RerunRequest
): Omit<Extract<ForgeRequest, { op: 'checks.rerun' }>, 'op' | 'operationId'> => ({
  ...value,
  units: value.units.map(unit => ({ ...unit })),
});

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
  expect(
    forgeRequestSchema.parse({
      ...producesRerun({
        ref,
        revision: 'head',
        units: [
          {
            unit: { kind: 'check', id: 'check', name: 'check' },
            rerun: { id: 'group', attempt: 1 },
          },
        ],
      }),
      op: 'checks.rerun',
      operationId: 'rerun',
    }).op
  ).toBe('checks.rerun');
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
  expect(
    consumesRerun({
      op: 'checks.rerun',
      value: {
        target: ref,
        outcome: 'applied',
        changed: true,
        ref,
        revision: 'head',
        units: [
          {
            unit: { kind: 'check', id: 'check', name: 'check' },
            rerun: { id: 'group', attempt: 2 },
          },
        ],
      },
    }).units[0].rerun?.attempt
  ).toBe(2);
});

test('standalone check reader retains unit IDs, rerun attempts and workflow approval', async () => {
  const { readChecks } = await import('../../workflows/sdlc/.shared/forge');
  const { checksObservationSchema, summarizeChecks } =
    await import('../../../packages/forge/src/operations');
  const ref = { repo: { host: 'forge.example', path: 'group/repo' }, number: 1 };
  const unit = {
    unit: { kind: 'check' as const, id: 'opaque-check', name: 'same-name' },
    nativeState: 'completed',
    nativeResult: 'failure',
    phase: 'completed' as const,
    result: 'failure' as const,
    state: 'red' as const,
    rerun: { id: 'opaque-group', attempt: 3 },
  };
  const value = checksObservationSchema.parse({
    ref,
    revision: 'opaque-revision',
    units: [unit],
    summary: summarizeChecks([unit]),
    required: null,
    approvalPending: true,
  });
  const response = { operationId: 'test', ok: true, result: { op: 'checks.state', value } };
  const previous = process.env.ARCHON_CLI_COMMAND;
  process.env.ARCHON_CLI_COMMAND = JSON.stringify([
    process.execPath,
    '-e',
    `console.log(${JSON.stringify(JSON.stringify(response))})`,
  ]);
  try {
    expect(readChecks(ref)).toMatchObject({
      revision: value.revision,
      approvalPending: true,
      units: [{ unit: unit.unit, rerun: unit.rerun }],
    });
  } finally {
    if (previous === undefined) delete process.env.ARCHON_CLI_COMMAND;
    else process.env.ARCHON_CLI_COMMAND = previous;
  }
});
