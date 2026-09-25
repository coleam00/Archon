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
  commands: ReadonlyMap<string, string> = new Map(Object.entries(BUNDLED_COMMANDS))
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
    yaml.replace(new RegExp(`^name: ${bundledKey}$`, 'm'), `name: ${name}`),
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

const BUNDLED = 'archon-create-issue';
const bundledYaml = (): string => {
  const yaml = BUNDLED_WORKFLOWS[BUNDLED];
  if (yaml === undefined) throw new Error(`${BUNDLED} is not bundled`);
  return yaml;
};
const renamed = (yaml: string, name: string): string =>
  yaml.replace(new RegExp(`^name: ${BUNDLED}$`, 'm'), `name: ${name}`);

describe('deriveBundledAncestry', () => {
  test('an unchanged copy under a custom name is identical to its original', () => {
    const copy = resolve(renamed(bundledYaml(), 'acme-issue-intake'));
    expect(deriveBundledAncestry(copy)).toEqual({
      derivedFrom: BUNDLED,
      derivedSimilarity: 'identical',
    });
  });

  test('a copy with a node added and a prompt edited is modified', () => {
    const original = resolve(bundledYaml());
    const firstPrompt = original.nodes.find(
      node => node.kind === 'agent' && node.source.kind === 'inline'
    );
    if (firstPrompt?.kind !== 'agent' || firstPrompt.source.kind !== 'inline')
      throw new Error('fixture needs an inline prompt node');
    const edited = renamed(bundledYaml(), 'acme-issue-intake')
      .replace(firstPrompt.source.prompt.split('\n')[0], 'Acme-specific instructions.')
      .replace(/^nodes:\n/m, 'nodes:\n  - id: acme-extra\n    bash: echo acme\n');
    expect(edited).toContain('Acme-specific instructions.');
    const ancestry = deriveBundledAncestry(resolve(edited));
    expect(ancestry).toEqual({ derivedFrom: BUNDLED, derivedSimilarity: 'modified' });
  });

  test('an unchanged copy of a workflow that includes another bundled workflow is identical', () => {
    expect(
      deriveBundledAncestry(resolveProjectCopy('archon-issue-review-full', 'acme-review'))
    ).toEqual({ derivedFrom: 'archon-issue-review-full', derivedSimilarity: 'identical' });
  });

  test('an unchanged project copy of a pack workflow is identical despite its project owner', () => {
    expect(deriveBundledAncestry(resolveProjectCopy('archon-plan', 'acme-plan'))).toEqual({
      derivedFrom: 'archon-plan',
      derivedSimilarity: 'identical',
    });
  });

  test('a copy that runs an overridden command is compared with the shipped workflow', () => {
    // The override changes the prompt an included block node runs, so the copy no longer
    // runs what Archon ships: modified, not identical.
    const overridden = new Map(Object.entries(BUNDLED_COMMANDS));
    overridden.set('archon-code-review-agent', 'Acme review instructions.');
    expect(
      deriveBundledAncestry(
        resolveProjectCopy('archon-issue-review-full', 'acme-review', overridden)
      )
    ).toEqual({ derivedFrom: 'archon-issue-review-full', derivedSimilarity: 'modified' });
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
    const custom = resolve(
      renamed(bundledYaml(), 'acme-secret-intake').replace(
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
