import { expect, test } from 'bun:test';
import {
  checksStateSchema,
  concludedCheckStates,
  type ChecksObservation as ContractObservation,
} from '../../../packages/forge/src/operations';
import { checkResultSchema } from '../../../packages/forge/src/events';
import { handleGithubOperation } from '../../../packages/adapters/src/forge/github/operations';
import { ghCheckUnit } from '../../workflows/sdlc/.shared/checks';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateStructuredOutput } from '../../../packages/providers/src/shared/structured-output';
import { parseWorkflow } from '../../../packages/workflows/src/loader';
import {
  CHECK_STATES,
  CONCLUDED_CHECK_STATES,
  type ChecksObservation as PackObservation,
  parseQualifiedPr,
  type PrRecord,
  type QualifiedPr,
} from '../../workflows/sdlc/.shared/forge';
import type { PrRef } from '../../../packages/forge/src/identity';
import {
  forgePrRecordSchema,
  type ForgePrRecord,
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
      return Response.json(statuses.map((state, id) => ({ id, context: `status-${state}`, state })));
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
// review ran, so the two must accept the same values (#3558 review R2).
test("archon-review's scope pr schema admits exactly what parseQualifiedPr accepts", () => {
  const file = join(import.meta.dir, '../../workflows/sdlc/review/archon-review.yaml');
  const parsed = parseWorkflow(readFileSync(file, 'utf8'), 'archon-review.yaml');
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
    return { pr, parserAccepts, schemaAccepts: validateStructuredOutput({ docs: false, pr }, schema).valid };
  });

  expect(verdicts.map(v => v.schemaAccepts)).toEqual(verdicts.map(v => v.parserAccepts));
  // Guard against a vacuous match: the parser must accept the qualified PR.
  expect(verdicts[0].parserAccepts).toBe(true);
});
