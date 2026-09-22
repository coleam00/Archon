import { describe, expect, test } from 'bun:test';
import { dryRunWorkflow } from './dry-run';
import { expandWorkflowIncludes } from './include-expander';
import { parseWorkflow } from './loader';

const reviewYaml = `
name: proof-review
description: Child review with a deterministic publisher
inputs:
  scope: { default: "" }
returns: publish
outcome_field: ready
nodes:
  - id: scope
    prompt: 'Review qualified target $INPUTS.scope'
  - id: synthesize
    prompt: Synthesize
    depends_on: [scope]
    output_format:
      type: object
      properties:
        ready: { type: boolean }
        action: { type: string, enum: [none, correct, replan] }
      required: [ready, action]
  - id: publish
    prompt: 'Publish verdict $synthesize.output.ready action $synthesize.output.action to $INPUTS.scope'
    depends_on: [synthesize]
    output_format:
      type: object
      properties:
        ready: { type: boolean }
        action: { type: string, enum: [none, correct, replan] }
      required: [ready, action]
`;

const deliveryYaml = `
name: proof-delivery
description: Parent delivery consuming the schema-owned PR record
returns: outcome
nodes:
  - id: pr
    prompt: Publish PR
    output_format: { type: object }
  - id: review
    include: proof-review
    with:
      scope: "$pr.output"
    depends_on: [pr]
  - id: outcome
    prompt: 'PR repo $pr.output.repo number $pr.output.number head $pr.output.head; review $review.output.action ready $review.output.ready'
    depends_on: [review]
`;

function load(yaml: string, file: string) {
  const parsed = parseWorkflow(yaml, file);
  if (!parsed.workflow) throw new Error(parsed.error.error);
  return parsed.workflow;
}

describe('lifecycle pack object projection through loader and executor', () => {
  test('generic owner-validated PR fields project into a child whose published verdict returns intact', async () => {
    const review = load(reviewYaml, 'proof-review.yaml');
    const delivery = load(deliveryYaml, 'proof-delivery.yaml');
    const expanded = expandWorkflowIncludes(
      new Map([
        [review.name, review],
        [delivery.name, delivery],
      ])
    );
    expect(expanded.errors).toEqual([]);
    const workflow = expanded.workflows.get('proof-delivery');
    if (!workflow) throw new Error('delivery did not compose');

    const record = {
      schemaVersion: 1,
      repo: { host: 'forge.example', path: 'owner/repo' },
      number: 42,
      url: 'https://forge.example/owner/repo/pulls/42',
      head: 'feature',
      base: 'dev',
      is_draft: true,
      state: 'open',
      head_repo: { host: 'forge.example', path: 'author/repo' },
      head_revision: 'head-oid',
      base_revision: 'base-oid',
      maintainer_can_modify: true,
    };
    const verdict = { ready: true, action: 'none' };
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: {
        pr: record,
        review__scope: 'scoped',
        review__synthesize: verdict,
        review__publish: verdict,
        outcome: 'delivered',
      },
    });

    expect(result.outcome).toBe('completed');
    const scope = result.trace.find(entry => entry.nodeId === 'review__scope');
    expect(scope?.resolvedText).toContain('"number":42');
    expect(scope?.resolvedText).toContain(
      '"head_repo":{"host":"forge.example","path":"author/repo"}'
    );
    const publisher = result.trace.find(entry => entry.nodeId === 'review__publish');
    expect(publisher?.resolvedText).toContain('Publish verdict true action none');
    const outcome = result.trace.find(entry => entry.nodeId === 'outcome');
    expect(outcome?.resolvedText).toBe(
      'PR repo {"host":"forge.example","path":"owner/repo"} number 42 head feature; review none ready true'
    );
  });

  test('the child authored outcome is read from the publisher rather than synthesize', async () => {
    const review = load(reviewYaml, 'proof-review.yaml');
    const expanded = expandWorkflowIncludes(new Map([[review.name, review]]));
    const workflow = expanded.workflows.get('proof-review');
    if (!workflow) throw new Error('review did not load');
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      inputs: { scope: '{}' },
      stubs: {
        scope: 'working diff',
        synthesize: { ready: false, action: 'correct' },
        publish: { ready: true, action: 'none' },
      },
    });
    expect(result.outcome).toBe('completed');
    expect(result.authoredOutcome).toBe('succeeded');
    expect(result.summary).toBe(JSON.stringify({ ready: true, action: 'none' }));
  });
});
