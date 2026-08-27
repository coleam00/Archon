import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFixtureFile } from '../packages/workflows/src/fixture-runner';
import { parseWorkflow } from '../packages/workflows/src/loader';
import { parseWhenAtom } from '../packages/workflows/src/when-atom';

const NODE_REFERENCE = join(
  import.meta.dir,
  '..',
  '.claude',
  'skills',
  'archon-cli',
  'authoring-workflows',
  'node-reference.md'
);
const reference = readFileSync(NODE_REFERENCE, 'utf8').replaceAll('\r\n', '\n');

function yamlFenceAfter(anchor: string): string {
  const anchorIndex = reference.indexOf(anchor);
  if (anchorIndex === -1) throw new Error(`Missing node-reference anchor: ${anchor}`);
  const fenceStart = reference.indexOf('```yaml\n', anchorIndex);
  if (fenceStart === -1) throw new Error(`Missing YAML fence after: ${anchor}`);
  const contentStart = fenceStart + '```yaml\n'.length;
  const fenceEnd = reference.indexOf('\n```', contentStart);
  if (fenceEnd === -1) throw new Error(`Unclosed YAML fence after: ${anchor}`);
  return reference.slice(contentStart, fenceEnd);
}

function indent(text: string, spaces = 2): string {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map(line => `${prefix}${line}`)
    .join('\n');
}

function expectWorkflowToLoad(yaml: string): void {
  const result = parseWorkflow(yaml, 'archon-cli-skill-example.yaml');
  expect(result.error).toBeNull();
  expect(result.workflow).not.toBeNull();
}

describe('archon-cli node reference examples', () => {
  test('workflow-level fields load with the documented worktree policy', () => {
    const fields = yamlFenceAfter('## Workflow-level fields');
    expectWorkflowToLoad(`${fields}
nodes:
  - id: implement
    prompt: noop
    output_format:
      type: object
      properties:
        green: {type: boolean}
      required: [green]
`);
  });

  test('workflow input fallback is explicit in the consuming prompt', () => {
    const consumer = yamlFenceAfter('An input default does not fall back');
    expectWorkflowToLoad(`
name: input-fallback-example
description: Validate the documented input fallback prompt
inputs:
  work:
    default: ""
nodes:
${indent(consumer)}
`);
    expect(consumer).toContain('$INPUTS.work');
    expect(consumer).toContain('$ARGUMENTS');
  });

  test('script bindings and loop completion examples satisfy the loader', () => {
    const script = yamlFenceAfter('### script —');
    expectWorkflowToLoad(`
name: script-example
description: Validate the documented script bindings
nodes:
  - id: implement
    prompt: implement
    output_format:
      type: object
      properties:
        green: {type: boolean}
      required: [green]
  - id: review
    prompt: review
${indent(script)}
`);

    const loop = yamlFenceAfter('### loop —');
    expectWorkflowToLoad(`
name: loop-example
description: Validate the documented loop completion channel
nodes:
  - id: record-start
    bash: echo start
${indent(loop)}
`);

    const loopGroup = yamlFenceAfter('### loop_group —');
    expectWorkflowToLoad(`
name: loop-group-example
description: Validate the documented independent verifier loop
nodes:
  - id: review-findings
    prompt: find issues
${indent(loopGroup)}
`);
  });

  test('approval decisions and explicit rework branch satisfy the loader', () => {
    const approval = yamlFenceAfter('### approval —');
    expectWorkflowToLoad(`
name: approval-example
description: Validate the documented structured approval decision
interactive: true
nodes:
  - id: plan
    prompt: plan
${indent(approval)}
`);
  });

  test('workflow reuse and composed fan-out examples satisfy the loader', () => {
    const reuse = yamlFenceAfter('### workflow / include —');
    expectWorkflowToLoad(`
name: reuse-example
description: Validate the documented reuse nodes
inputs:
  branch:
    required: true
nodes:
${indent(reuse)}
`);

    const fanOut = yamlFenceAfter('Put `fan_out:` on `include:`');
    expectWorkflowToLoad(`
name: compose-fan-out-example
description: Validate the documented in-run fan-out node
nodes:
${indent(fanOut)}
`);
  });

  test('structured branches and fixture inputs use their executable shapes', () => {
    expect(parseWhenAtom("$classify.output.type == 'BUG'")).toEqual({
      ref: { kind: 'node', nodeId: 'classify', field: 'type' },
      operator: '==',
      expected: 'BUG',
    });
    expect(reference).toContain('when: "$classify.output.type == \'BUG\'"');

    const fixture = yamlFenceAfter('## Fixtures —');
    expect(parseFixtureFile(fixture, 'documented.stubs.yaml').declaration.inputs).toEqual({
      branch: 'task-42',
    });
  });
});
