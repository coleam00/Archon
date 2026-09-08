import { createGitHubPlugin } from './github/plugin';
import { publicRequestSchema, publicResultSchemas, RESOLVE_OP } from './schemas';
import { PINNED_MERGE_OP } from './pinned-merge-schemas';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { checkPluginConformance, checksVerdictFixture } from './conformance';
import { CHECKS, CHECKS_STATE_OP, checksVerdictSchema, pluginMetadataSchema } from './schemas';

test('a contradictory unit cannot certify green through a schema-valid count total', () => {
  const verdict = checksVerdictFixture(CHECKS.green);
  verdict.units[0].state = CHECKS.red;
  expect(checksVerdictSchema.safeParse(verdict).success).toBe(false);
  verdict.units = [];
  expect(checksVerdictSchema.safeParse(verdict).success).toBe(false);
});

test('additive capabilities and metadata do not change protocol compatibility', () => {
  expect(
    pluginMetadataSchema.parse({
      protocol: 1,
      name: 'test',
      version: '2.0',
      forge: 'example',
      hosts: ['example.test'],
      capabilities: ['future.operation'],
      additional: 'ignored',
    }).capabilities
  ).toEqual(['future.operation']);
});

test('the executable conformance kit round-trips non-ASCII and rejects protocol mismatch', async () => {
  const candidate = {
    source: 'fixture',
    command: process.execPath,
    args: [join(import.meta.dir, 'dispatch/fixtures/well-behaved-plugin.ts'), '{}'],
  };
  await checkPluginConformance(candidate, [
    {
      op: CHECKS_STATE_OP,
      request: { ref: { repo: { host: 'example.test', path: 'owner/repo' }, number: 42 } },
      expected: checksVerdictFixture(CHECKS.green),
    },
  ]);
  await expect(
    checkPluginConformance({ ...candidate, args: [candidate.args[0], '{"protocol":999}'] }, [])
  ).rejects.toThrow('metadata failed conformance');
});

test('lightweight GitHub metadata covers the owning public and pinned schemas', () => {
  const operations = publicRequestSchema.options.map(schema => schema.shape.op.value).sort();
  expect(Object.keys(publicResultSchemas).sort()).toEqual(operations);
  expect(createGitHubPlugin().metadata().capabilities.slice().sort()).toEqual(
    [RESOLVE_OP, CHECKS_STATE_OP, PINNED_MERGE_OP, ...operations].sort()
  );
});
