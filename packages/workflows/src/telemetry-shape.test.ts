import { beforeAll, describe, expect, test } from 'bun:test';
import { registerBuiltinProviders } from '@archon/providers';
import { BUNDLED_WORKFLOWS } from './defaults/bundled-defaults';
import { expandWorkflowIncludes } from './include-expander';
import { parseWorkflow } from './loader';
import type { ResolvedWorkflow } from './schemas/workflow';
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
