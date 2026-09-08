import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decide, deliveryResult } from '../.archon/workflows/sdlc/deliver/scripts/outcome';
import {
  BUNDLED_COMMANDS,
  BUNDLED_WORKFLOWS,
  BUNDLED_WORKFLOW_OWNERS,
} from '../packages/workflows/src/defaults/bundled-defaults';
import { parseWorkflow } from '../packages/workflows/src/loader';
import { qualifyWorkflowResources } from '../packages/workflows/src/packaged-workflow';
import { expandWorkflowIncludes } from '../packages/workflows/src/include-expander';
import { dryRunWorkflow } from '../packages/workflows/src/dry-run';
import { parseFixtureFile } from '../packages/workflows/src/fixture-runner';

const root = resolve(import.meta.dir, '..');
const pr = {
  number: 3,
  url: 'https://github.com/example/repo/pull/3',
  head: 'feature',
  base: 'dev',
  repository: 'example/repo',
  head_sha: 'a'.repeat(40),
  base_sha: 'b'.repeat(40),
  is_draft: false,
};

describe('SDLC delivery result', () => {
  test('all authored terminal routes return a typed outcome', () => {
    expect(
      decide({ ARTIFACTS_DIR: root, INPUTS_MODE: 'deliver', INPUTS_PR: JSON.stringify(pr) }).pr
    ).toEqual(pr);
    expect(decide({ ARTIFACTS_DIR: root, INPUTS_MODE: 'deliver', INPUTS_PR: 'null' }).outcome).toBe(
      'blocked'
    );
    for (const route of ['no_action', 'plan', 'investigate', 'deliver']) {
      const result = decide({
        ARTIFACTS_DIR: root,
        INPUTS_MODE: 'ship',
        INPUTS_ROUTE: route,
        INPUTS_SUMMARY: 'Verified brief',
      });
      expect(result.outcome).toBe(route === 'no_action' ? 'no_action' : 'blocked');
      expect(result.pr).toBeNull();
      expect(result.reports.length).toBeGreaterThan(0);
    }
    const died = decide({
      ARTIFACTS_DIR: root,
      INPUTS_MODE: 'ship',
      INPUTS_ROUTE: 'plan',
      INPUTS_GATE_PLANNED: '{}',
    });
    expect(died.summary).toContain('started but did not complete');
    expect(
      decide({ ARTIFACTS_DIR: root, INPUTS_MODE: 'upkeep', INPUTS_ROUTE: 'update' }).outcome
    ).toBe('blocked');
  });

  test('creation-time identity and prose URLs cannot masquerade as delivery', () => {
    expect(() => deliveryResult(pr)).toThrow();
    expect(() => deliveryResult(pr.url)).toThrow();
    expect(() =>
      decide({
        ARTIFACTS_DIR: root,
        INPUTS_MODE: 'deliver',
        INPUTS_PR: JSON.stringify({ ...pr, is_draft: true }),
      })
    ).toThrow('draft');
  });

  test('every consumer declares the same result schema and PR shape', () => {
    const schemas = ['archon-deliver', 'archon-ship', 'archon-upkeep'].map(name => {
      const workflow = parseWorkflow(BUNDLED_WORKFLOWS[name]!, `${name}.yaml`).workflow!;
      const node = workflow.nodes.find(n => n.id === workflow.returns)!;
      if (!('output_format' in node)) throw new Error('Result must declare its schema');
      return node.output_format;
    });
    expect(schemas[1]).toEqual(schemas[0]);
    expect(schemas[2]).toEqual(schemas[0]);
    const prWorkflow = parseWorkflow(BUNDLED_WORKFLOWS['archon-pr']!, 'archon-pr.yaml').workflow!;
    const prNode = prWorkflow.nodes.find(n => n.id === 'pr')!;
    if (!('output_format' in prNode) || !prNode.output_format)
      throw new Error('PR must declare its schema');
    const prSchema = prNode.output_format;
    const resultSchema = schemas[0] as {
      properties: { pr: { properties: unknown; required: unknown } };
    };
    expect(resultSchema.properties.pr.properties).toEqual(prSchema.properties);
    expect(resultSchema.properties.pr.required).toEqual(prSchema.required);
  });
});

const definitions = new Map(
  Object.entries(BUNDLED_WORKFLOWS)
    .filter(([name]) => BUNDLED_WORKFLOW_OWNERS[name]?.pack === 'sdlc')
    .map(([name, content]) => {
      const parsed = parseWorkflow(content, `${name}.yaml`);
      if (!parsed.workflow) throw new Error(parsed.error.error);
      const owner = BUNDLED_WORKFLOW_OWNERS[name];
      return [
        name,
        owner
          ? qualifyWorkflowResources(parsed.workflow, { ...owner, source: 'bundled' })
          : parsed.workflow,
      ];
    })
);
const expanded = expandWorkflowIncludes(definitions, new Map(Object.entries(BUNDLED_COMMANDS)));

describe('issue to reviewed PR composition', () => {
  for (const scenario of [
    'planned-delivered',
    'direct-delivered',
    'rooted-delivered',
    'no-action',
    'plan-blocked',
    'unrooted',
    'delivery-died',
    'delivery-died-after-pr',
    'delivered-unusable',
  ]) {
    test(
      scenario,
      async () => {
        const workflow = expanded.workflows.get('archon-ship');
        if (!workflow) throw new Error(JSON.stringify(expanded.errors));
        const path = resolve(root, `.archon/workflows/sdlc/ship/fixtures/${scenario}.stubs.yaml`);
        const fixture = parseFixtureFile(await readFile(path, 'utf8'), path);
        const result = await dryRunWorkflow({
          workflow,
          cwd: root,
          userMessage: '',
          stubs: fixture.stubs,
          inputs: fixture.declaration.inputs,
          defaultStubs: true,
          execCode: true,
        });
        expect(
          result.outcome,
          JSON.stringify(
            result.trace.filter(node => node.state === 'failed'),
            null,
            2
          )
        ).toBe(fixture.declaration.expect);
        for (const [nodeId, fragment] of Object.entries(
          fixture.declaration['resolved-text-contains'] ?? {}
        )) {
          expect(result.trace.find(n => n.nodeId === nodeId)?.resolvedText).toContain(fragment);
        }
        const outcome = result.trace.find(n => n.nodeId === 'outcome');
        if (scenario === 'delivered-unusable') {
          expect(result.trace.find(n => n.nodeId === 'deliver__outcome')?.state).toBe('failed');
        } else {
          expect(outcome?.state).toBe('completed');
          const expected = scenario.endsWith('delivered')
            ? 'delivered'
            : scenario === 'no-action'
              ? 'no_action'
              : 'blocked';
          expect(JSON.parse(outcome?.output ?? '{}').outcome).toBe(expected);
        }
      },
      20000
    );
  }
});
