import { beforeAll, describe, expect, test } from 'bun:test';
import { registerBuiltinProviders } from '@archon/providers';
import { basename } from 'node:path';
import {
  BUNDLED_COMMANDS,
  BUNDLED_WORKFLOWS,
  BUNDLED_WORKFLOW_OWNERS,
  BUNDLED_WORKFLOW_PATHS,
} from './defaults/bundled-defaults';
import { expandWorkflowIncludes } from './include-expander';
import { parseWorkflow } from './loader';
import { qualifyWorkflowResources } from './packaged-workflow';
import type { ResolvedWorkflow, WorkflowDefinition } from './schemas/workflow';
import { deriveBundledAncestry, describeWorkflowShape, promptCharsBucket } from './telemetry-shape';

beforeAll(() => {
  registerBuiltinProviders();
});

/** Parse and resolve a workflow the way discovery does for an include-free file. */
function resolve(yaml: string): ResolvedWorkflow {
  const parsed = parseWorkflow(yaml, 'custom.yaml');
  if (!parsed.workflow) throw new Error(parsed.error.error);
  const { workflows, errors } = expandWorkflowIncludes(
    new Map([[parsed.workflow.name, parsed.workflow]])
  );
  const resolved = workflows.get(parsed.workflow.name);
  if (!resolved) throw new Error(errors.map(e => e.error).join('; '));
  return resolved;
}

/**
 * Resolve a project copy of a bundled workflow the way discovery does: the copy sits
 * beside the bundled workflows it may include, a pack copy is qualified with a project
 * owner, and includes expand against the command bodies this install resolves.
 */
function resolveProjectCopy(
  bundledKey: string,
  name: string,
  commands: ReadonlyMap<string, string> = new Map(Object.entries(BUNDLED_COMMANDS)),
  edit: (yaml: string) => string = yaml => yaml
): ResolvedWorkflow {
  const rawByName = new Map<string, WorkflowDefinition>();
  for (const [key, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    const path = BUNDLED_WORKFLOW_PATHS[key];
    const { workflow } = parseWorkflow(content, path ? basename(path) : `${key}.yaml`);
    if (!workflow) continue;
    const owner = BUNDLED_WORKFLOW_OWNERS[key];
    if (owner) qualifyWorkflowResources(workflow, { source: 'bundled', ...owner });
    rawByName.set(workflow.name, workflow);
  }
  const yaml = BUNDLED_WORKFLOWS[bundledKey];
  if (yaml === undefined) throw new Error(`${bundledKey} is not bundled`);
  const parsed = parseWorkflow(
    edit(yaml.replace(new RegExp(`^name: ${bundledKey}$`, 'm'), `name: ${name}`)),
    `${name}.yaml`
  );
  if (!parsed.workflow) throw new Error(parsed.error.error);
  const owner = BUNDLED_WORKFLOW_OWNERS[bundledKey];
  if (owner) qualifyWorkflowResources(parsed.workflow, { ...owner, source: 'project' });
  rawByName.set(name, parsed.workflow);
  const { workflows, errors } = expandWorkflowIncludes(rawByName, commands);
  const resolved = workflows.get(name);
  if (!resolved) throw new Error(errors.map(e => e.error).join('; '));
  return resolved;
}

describe('deriveBundledAncestry', () => {
  test('a copy with a node added is modified', () => {
    const copy = resolveProjectCopy('archon-implement', 'acme-implement', undefined, yaml =>
      yaml.replace(/^nodes:\n/m, 'nodes:\n  - id: acme-extra\n    bash: echo acme\n')
    );
    expect(copy.nodes.some(node => node.id === 'acme-extra')).toBe(true);
    expect(deriveBundledAncestry(copy)).toEqual({
      derivedFrom: 'archon-implement',
      derivedSimilarity: 'modified',
    });
  });

  test('an unchanged copy of a workflow that includes another bundled workflow is identical', () => {
    expect(deriveBundledAncestry(resolveProjectCopy('archon-deliver', 'acme-deliver'))).toEqual({
      derivedFrom: 'archon-deliver',
      derivedSimilarity: 'identical',
    });
  });

  test('an unchanged project copy of a pack workflow is identical despite its project owner', () => {
    expect(deriveBundledAncestry(resolveProjectCopy('archon-plan', 'acme-plan'))).toEqual({
      derivedFrom: 'archon-plan',
      derivedSimilarity: 'identical',
    });
  });

  test('an unrelated custom workflow has no ancestry', () => {
    const custom = resolve(
      [
        'name: acme-nightly',
        'description: Acme nightly job.',
        'nodes:',
        '  - id: acme-fetch',
        '    bash: echo fetch',
        '  - id: acme-report',
        '    prompt: Summarize the Acme fetch.',
        '    depends_on: [acme-fetch]',
      ].join('\n')
    );
    expect(deriveBundledAncestry(custom)).toBeUndefined();
  });
});

describe('describeWorkflowShape', () => {
  test('counts node types, depth, fan-out and distinct commands on a known graph', () => {
    const workflow = resolve(
      [
        'name: acme-shape',
        'description: Shape fixture.',
        'nodes:',
        '  - id: root',
        '    bash: echo root',
        '  - id: left',
        '    command: acme-left',
        '    depends_on: [root]',
        '  - id: right',
        '    command: acme-left',
        '    depends_on: [root]',
        '  - id: middle',
        '    prompt: Twelve chars',
        '    depends_on: [root]',
        '  - id: join',
        '    prompt: Join them.',
        '    depends_on: [left, right, middle]',
      ].join('\n')
    );
    expect(describeWorkflowShape(workflow)).toEqual({
      nodeCounts: { bash: 1, command: 2, prompt: 2 },
      graphDepth: 3,
      maxFanOut: 3,
      commandRefs: 1,
      promptCharsBucket: 'lt_1k',
    });
  });

  test('prompt size buckets break at 1k, 5k and 20k characters', () => {
    expect([0, 1, 999, 1_000, 4_999, 5_000, 19_999, 20_000].map(n => promptCharsBucket(n))).toEqual(
      ['none', 'lt_1k', 'lt_1k', '1k_5k', '1k_5k', '5k_20k', '5k_20k', 'gte_20k']
    );
  });

  test('nothing that describes a custom workflow carries its ids, names or text', () => {
    const custom = resolveProjectCopy('archon-implement', 'acme-secret-intake', undefined, yaml =>
      yaml.replace(
        /^nodes:\n/m,
        'nodes:\n  - id: acme-secret-node\n    prompt: Acme secret prompt text.\n'
      )
    );
    const sent = JSON.stringify({
      shape: describeWorkflowShape(custom),
      ancestry: deriveBundledAncestry(custom),
    });
    for (const secret of ['acme-secret-intake', 'acme-secret-node', 'Acme secret prompt'])
      expect(sent).not.toContain(secret);
  });
});
