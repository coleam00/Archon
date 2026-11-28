// @archon-test-isolated
import { describe, expect, test } from 'bun:test';
import { displayDeclarationFindings } from './display-declarations';
import { parseWorkflowYaml } from './loader/test-utils';
import { makeTestComposedWorkflow } from './test-utils';

/** A stage returning `{ outcome, round, nested: { count }, list: [{ url }] }`, with `display`. */
const stage = (display: string) =>
  makeTestComposedWorkflow(
    [
      parseWorkflowYaml(`name: check
description: checks
returns: { node: end, outcome: outcome }
nodes:
  - id: end
    bash: echo '{"outcome":"approve"}'
    output_format:
      type: object
      properties:
        outcome: { type: string, enum: [approve, return] }
        round: { type: integer }
        nested: { type: object, properties: { count: { type: integer } } }
        list: { type: array, items: { type: object, properties: { url: { type: string } } } }
        either: { anyOf: [{ type: object, properties: { a: { type: string } } }, { type: string }] }
        "a/b": { type: string }
      required: [outcome]
${display}`).workflow,
    ],
    'check'
  );

const messages = (display: string): string[] =>
  displayDeclarationFindings(stage(display)).map(finding => finding.message);

describe("a display's marks and results, as archon validate reads them", () => {
  test('a mark whose means no reader knows is refused, on the stage and in its replaces', () => {
    expect(
      messages(`display:
  label: Check
  marks: [{ node: end, outcome: return, means: retruns }]
  replaces:
    - workflow: older
      marks: [{ node: loop.verdict, outcome: return, means: sends-back }]
`)
    ).toEqual([
      "Workflow 'check' display.marks: step 'end' outcome 'return' means 'retruns', which no reader knows (known: returns, approves)",
      "Workflow 'check' display.replaces 'older' marks: step 'loop.verdict' outcome 'return' means 'sends-back', which no reader knows (known: returns, approves)",
    ]);
    expect(
      messages(`display:
  label: Check
  marks:
    - { node: end, outcome: return, means: returns }
    - { node: end, outcome: approve, means: approves }
`)
    ).toEqual([]);
  });

  test("a results pointer must reach a place the returns node's output_format declares", () => {
    expect(
      messages(`display:
  label: Check
  results:
    round: /round
    count: /nested/count
    url: /list/0/url
    either: /either/a
    escaped: /a~1b
`)
    ).toEqual([]);
    expect(
      messages(`display:
  label: Check
  results: { allowance: /allowance, deep: /nested/nope, index: /list/x/url }
`)
    ).toEqual([
      "Workflow 'check' display.results 'allowance' points at '/allowance', which node 'end' output_format does not declare",
      "Workflow 'check' display.results 'deep' points at '/nested/nope', which node 'end' output_format does not declare",
      "Workflow 'check' display.results 'index' points at '/list/x/url', which node 'end' output_format does not declare",
    ]);
  });

  test('a results pointer in a workflow with no returns node points at nothing', () => {
    const plain = makeTestComposedWorkflow(
      [
        parseWorkflowYaml(`name: plain
description: returns nothing
nodes:
  - id: end
    bash: 'true'
display: { label: Plain, results: { round: /round } }
`).workflow,
      ],
      'plain'
    );
    expect(displayDeclarationFindings(plain).map(finding => finding.message)).toEqual([
      "Workflow 'plain' display.results 'round' points at '/round', but the workflow declares no returns node",
    ]);
  });
});
