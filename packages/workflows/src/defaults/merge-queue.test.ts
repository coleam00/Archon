import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { removeTempTree } from '@archon/paths/test-utils';

const root = join(import.meta.dir, '../../../..');
const script = join(root, '.archon/workflows/sdlc/merge-queue/scripts/merge-queue.py');
const fixture = join(import.meta.dir, 'fixtures/merge-queue-scenario.py');
const publicSchema =
  process.env.ARCHON_MERGE_QUEUE_PUBLIC_SCHEMA ?? join(root, 'packages/forge/src/schemas.ts');
const pinnedSchema =
  process.env.ARCHON_MERGE_QUEUE_PINNED_SCHEMA ??
  join(root, 'packages/forge/src/pinned-merge-schemas.ts');

async function ownerSchemas(path: string): Promise<Record<string, z.ZodType>> {
  const imported: unknown = await import(pathToFileURL(path).href);
  const exports = z.record(z.string(), z.unknown()).parse(imported);
  const schemas: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries(exports)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      'parse' in value &&
      typeof value.parse === 'function'
    ) {
      schemas[key] = z.custom<z.ZodType>().parse(value);
    }
  }
  return schemas;
}

describe('supervised queue: real Git and computations, simulated agents and forge CLI', () => {
  for (const scenario of [
    'green',
    'malformed',
    'mixed_repo',
    'mixed_base',
    'draft',
    'wrong_order',
    'denied_order',
    'prose_approval',
    'ci_none',
    'ci_red',
    'required_red',
    'no_ci_policy',
    'stale_head',
    'stale_base',
    'dirty',
    'conflict',
    'joint_red',
    'missing_evidence',
    'no_checks',
    'paused_resume',
    'denied_candidates',
    'changed_evidence',
    'base_after_gate',
    'response_loss',
    'failed_operation',
  ]) {
    describe(scenario, () => {
      let temporary: string;
      async function run(phase: string): Promise<void> {
        const child = Bun.spawn(
          [
            process.platform === 'win32' ? 'python' : 'python3',
            fixture,
            script,
            temporary,
            scenario,
            phase,
          ],
          { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
        );
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, error: stderr || (code ? stdout : '') }).toEqual({ code: 0, error: '' });
      }
      beforeAll(async () => {
        temporary = await mkdtemp(join(tmpdir(), 'archon-merge-queue-'));
        await run('setup');
      });
      afterAll(async () => {
        if (temporary) await removeTempTree(temporary);
      });
      const early = [
        'malformed',
        'mixed_repo',
        'mixed_base',
        'draft',
        'wrong_order',
        'denied_order',
        'prose_approval',
      ].includes(scenario);
      const held = [
        'ci_none',
        'ci_red',
        'required_red',
        'stale_head',
        'stale_base',
        'dirty',
        'conflict',
        'joint_red',
        'missing_evidence',
        'no_checks',
      ].includes(scenario);
      if (early) {
        it('rejects invalid intake or order approval', async () => {
          await run('exercise');
        });
      } else {
        it('pins intake and approves order', async () => {
          await run('intake');
        });
        it('checks the first composition', async () => {
          await run('prepare1');
        });
        it('checks or holds the dependent composition', async () => {
          await run('prepare2');
        });
        if (!held) {
          it('enforces candidate approval and first pinned merge', async () => {
            await run('merge1');
          });
          if (scenario === 'response_loss')
            it('recovers the exact lost response', async () => {
              await run('recover');
            });
          if (['green', 'no_ci_policy', 'paused_resume', 'response_loss'].includes(scenario)) {
            it('merges onto the approved preceding candidate', async () => {
              await run('merge2');
            });
            it('resumes repeatedly without duplicate publication', async () => {
              await run('replay');
            });
          }
        }
      }
      if (scenario === 'green') {
        it.skipIf(!existsSync(pinnedSchema))(
          'conforms to the actual public and pinned forge owner schemas',
          async () => {
            const [publicOwner, pinnedOwner] = await Promise.all([
              ownerSchemas(publicSchema),
              ownerSchemas(pinnedSchema),
            ]);
            const state = z
              .object({
                items: z.array(
                  z.object({
                    pr: z.unknown(),
                    merge_request: z.unknown(),
                    merge_result: z.unknown(),
                    head_checks: z.unknown(),
                  })
                ),
              })
              .parse(JSON.parse(readFileSync(join(temporary, 'artifacts/queue.json'), 'utf8')));
            for (const item of state.items) {
              expect(publicOwner.prRecordSchema.parse(item.pr)).toEqual(item.pr);
              expect(publicOwner.checksVerdictSchema.parse(item.head_checks)).toEqual(
                item.head_checks
              );
              expect(pinnedOwner.pinnedMergeRequestSchema.parse(item.merge_request)).toEqual(
                item.merge_request
              );
              expect(pinnedOwner.pinnedMergeResultSchema.parse(item.merge_result)).toEqual(
                item.merge_result
              );
              const { ref } = z.object({ ref: z.unknown() }).parse(item.pr);
              expect(publicOwner.publicRequestSchema.parse({ op: 'pr.view', ref })).toEqual({
                op: 'pr.view',
                ref,
              });
            }
          }
        );
      }
    });
  }
});
