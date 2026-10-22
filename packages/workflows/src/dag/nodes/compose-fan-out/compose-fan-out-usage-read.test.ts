// @archon-test-isolated
import { describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import { buildInstanceSnapshots } from '../../../fan-out-identity';
import type { RunChildWorkflowFn } from '../../child-run';
import {
  composeInnerStep,
  composeScope,
  createMockDeps,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  persistedEvents,
  runUsageWrites,
} from '../../test-utils';

const tempRoots = trackTempRoots();

describe('composed instance accounting read rejection', () => {
  for (const recovered of [false, true]) {
    for (const fanOut of [false, true]) {
      for (const maxParallel of [1, 2]) {
        it(`retains paid sibling usage (${JSON.stringify({ recovered, fanOut, maxParallel })})`, async () => {
          const cwd = await mkdtemp(join(tmpdir(), 'compose-usage-read-'));
          tempRoots(cwd);
          const workflows = join(cwd, '.archon', 'workflows');
          await mkdir(workflows, { recursive: true });
          await writeFile(
            join(workflows, 'block.yaml'),
            `name: block
description: composed child
mutates_checkout: false
nodes:
  - id: child
    workflow: child
${fanOut ? "    fan_out:\n      items: '[1]'\n      as: item\n" : ''}`
          );
          await writeFile(
            join(workflows, 'child.yaml'),
            'name: child\ndescription: child\nnodes:\n  - id: work\n    bash: echo child'
          );
          const store = createMockStore();
          const [, unreadable] = buildInstanceSnapshots(['paid', 'unreadable']);
          if (recovered) {
            await store.persistWorkflowEvent({
              workflow_run_id: 'parent',
              step_name: composeInnerStep(unreadable.identity, 'child'),
              event_type: 'node_failed',
              data: {
                type: 'workflow',
                error: 'interrupted',
                cost_usd: 0.01,
                tokens: { input: 7, output: 3 },
              },
            });
          }
          store.getDagResumeSnapshot.mockImplementation(async runId =>
            foldDagResumeSnapshot(persistedEvents(store), runId)
          );
          const priorUsage = await store.getDagResumeSnapshot('parent');
          const cause = new Error('instance usage unavailable');
          let reads = 0;
          const listEvents = store.listWorkflowEvents.getMockImplementation();
          if (!listEvents) throw new Error('missing event reader');
          store.listWorkflowEvents.mockImplementation(async () => {
            if (++reads === 2) throw cause;
            return listEvents('parent');
          });
          const runChildWorkflow = mock<RunChildWorkflowFn>(async () => ({
            childRunId: 'paid-child',
            status: 'completed',
            output: 'paid',
            costUsd: 0.03,
            tokens: { input: 21, output: 9 },
          }));
          await executeDagWorkflow(
            dagOptions({
              cwd,
              deps: createMockDeps(store),
              workflowRun: makeWorkflowRun('parent'),
              priorUsage,
              runChildWorkflow,
              workflow: {
                name: 'parent',
                nodes: [
                  {
                    id: 'fan',
                    kind: 'compose_fan_out',
                    include: 'block',
                    fan_out: {
                      items: '["paid","unreadable"]',
                      as: 'item',
                      max_parallel: maxParallel,
                      join: 'all_success',
                    },
                  },
                ],
              },
            })
          );
          expect(reads).toBe(2);
          expect(runChildWorkflow).toHaveBeenCalledTimes(1);
          expect(runUsageWrites(store).at(-1)).toMatchObject({
            total_cost_usd: expect.closeTo(recovered ? 0.04 : 0.03, 8),
            total_tokens_in: recovered ? 28 : 21,
            total_tokens_out: recovered ? 12 : 9,
          });
          const events = persistedEvents(store);
          expect(
            events.some(event => event.step_name === `${composeScope()}__${unreadable.identity}`)
          ).toBe(false);
          expect(
            events.find(event => event.step_name === 'fan' && event.event_type === 'node_failed')
              ?.data?.error
          ).toContain(cause.message);
          const folded = await store.getDagResumeSnapshot('parent');
          expect(folded.costUsd).toBeCloseTo(recovered ? 0.04 : 0.03);
          expect(folded.tokens).toMatchObject({
            input: recovered ? 28 : 21,
            output: recovered ? 12 : 9,
          });
        });
      }
    }
  }
});
