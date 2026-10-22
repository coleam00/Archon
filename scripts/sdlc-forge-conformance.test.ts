/**
 * The SDLC pack restates the forge contract it consumes, because the pack runs outside this
 * repository and may not import engine code. These tests hold each restated projection to
 * the owner it copies: `@archon/forge` for wire types, schemas and error kinds, and
 * `@archon/paths` for the per-host token names.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { ghTokenKeysForHost } from '@archon/paths/github-token-env';
import {
  cliForgeMetadataRequestSchema,
  cliForgeResponseSchema,
} from '../packages/forge/src/cli-response';
import type { PrRef } from '../packages/forge/src/identity';
import {
  closeReasonSchema,
  type ForgePrRecord,
  forgePrRecordSchema,
} from '../packages/forge/src/lifecycle';
import {
  type ForgeMutationFailure,
  type ForgeRequest,
  type ForgeResponse,
  forgeErrorSchema,
  forgeRequestSchema,
} from '../packages/forge/src/operations';
import {
  forgeOperation,
  gitCheckout,
  PR,
  packScriptRunner,
} from '../.archon/scripts/__tests__/deliver-checks-harness';
import {
  forgeResult,
  type MergeRequest,
  type MergeResult,
  type MutationFailure,
  type PrRecord,
  type QualifiedPr,
  REMEDY,
  type ReviewsResult,
} from '../.archon/workflows/sdlc/.shared/forge';
import {
  ghTokenNames,
  REQUIRED_FORGE_OPERATIONS,
} from '../.archon/workflows/sdlc/.shared/forge-check';
import { MERGE_QUEUE_FORGE_OPERATIONS } from '../.archon/workflows/sdlc/.shared/merge';
import { CLOSE_REASONS } from '../.archon/workflows/sdlc/.shared/issue';

const { runPackScript } = packScriptRunner();
const trackTempRoot = trackTempRoots();

// These assignments check that the pack's projection stays compatible with the owning
// wire type in both directions.
const consumesPr = (value: PrRef): QualifiedPr => value;
const producesPr = (value: QualifiedPr): PrRef => value;
const consumesPrRecord = (value: ForgePrRecord): PrRecord => value;
const producesPrRecord = (value: PrRecord): ForgePrRecord => value;

test('the pack consumes the owning qualified identity and pull-request record', () => {
  const ref = { repo: { host: 'forge.example', path: 'group/team/repo' }, number: 42 };
  expect(producesPr(consumesPr(ref))).toEqual(ref);

  // parsePrRecord validates every pull-request result the pack's write nodes read, so a
  // field the owning schema grows must reach it or the pack starts rejecting records
  // @archon/forge produced.
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
  expect(forgeErrorSchema.shape.kind.options).toEqual(expect.arrayContaining(Object.keys(REMEDY)));
});

test('every reason the pack closes an issue with is a forge close reason', () => {
  for (const reason of CLOSE_REASONS) expect(closeReasonSchema.parse(reason)).toBe(reason);
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

test('the pack projections of the merge and review operations carry typed evidence', () => {
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

// Delivery and the merge queue each preflight their own operations; merge-queue.test.ts
// proves the merge queue's list against the operations it calls.
test('preflight capabilities cover the forge operations the pack calls', () => {
  const root = join(import.meta.dir, '../.archon/workflows/sdlc');
  const sources = [...new Bun.Glob('**/*.{ts,md}').scanSync({ cwd: root, dot: true })]
    .filter(file => file !== '.shared/forge-check.ts' && file !== '.shared/merge.ts')
    .map(file => readFileSync(join(root, file), 'utf8'));
  const used = forgeRequestSchema.options
    .map(schema => schema.shape.op.value)
    .filter(op =>
      sources.some(text =>
        [`'${op}'`, `"${op}"`, `\`${op}\``, `forge ${op} `].some(token => text.includes(token))
      )
    );
  expect(used).toContain('checks.state');
  const preflighted = new Set([...REQUIRED_FORGE_OPERATIONS, ...MERGE_QUEUE_FORGE_OPERATIONS]);
  expect(used.sort()).toEqual([...preflighted].sort());
});

test('the pack reads host responses with credential attribution and metadata intact', () => {
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

test('forge-check names the token env vars @archon/paths assigns to each gh host', () => {
  for (const host of ['github.com', 'acme.ghe.com', 'git.example.com'])
    expect(ghTokenNames(host)).toEqual(ghTokenKeysForHost(host));
});

test("forge-check's metadata request conforms to the CLI host input", () => {
  const run = runPackScript('deliver/scripts/forge-check', {
    cwd: gitCheckout({}, trackTempRoot),
    source: 'forge',
    forge: {
      kind: 'fake',
      response: [
        forgeOperation('metadata', { capabilities: REQUIRED_FORGE_OPERATIONS }),
        forgeOperation('pr.view', null),
      ],
    },
    inputs: { ARCHON_HOME: join(tmpdir(), 'archon-home-elsewhere') },
  });
  expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
  expect(run.forge[0]).toContain('forge metadata');
  const request = cliForgeMetadataRequestSchema.parse({
    ...JSON.parse(run.forgeRequests[0] ?? ''),
    op: 'metadata',
    operationId: 'cli-operation',
  });
  expect(request.host).toBe(PR.repo.host);
});
