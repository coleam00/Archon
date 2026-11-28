// @archon-test-isolated
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestWorkflow, makeTestComposedWorkflow } from './test-utils';
import { dryRunWorkflow, useDryRunFiles } from './dry-run-test-utils';

const { temporaryDirectory } = useDryRunFiles();
const verdictSchema = {
  type: 'object',
  properties: { done: { type: 'boolean', default: true } },
  required: ['done'],
};

const relays = [
  { name: 'shell-current', bash: 'printf "%s" $verdict.output' },
  { name: 'shell-field', bash: 'printf \'{"done":%s}\' $verdict.output.done' },
  {
    name: 'shell-prior',
    bash: 'value=$LOOP_PREV.verdict.output; if test -n "$value"; then printf "%s" "$value"; else printf \'{"done":false}\'; fi',
  },
  {
    name: 'shell-prior-field',
    bash: 'done=$LOOP_PREV.verdict.output.done; printf \'{"done":%s}\' "${done:-false}"',
  },
  {
    name: 'script-current',
    script: 'console.log(JSON.stringify($verdict.output))',
    runtime: 'bun',
  },
  {
    name: 'script-field',
    script: 'console.log(JSON.stringify({done:$verdict.output.done}))',
    runtime: 'bun',
  },
  {
    name: 'script-binding',
    script: 'console.log(process.env.INPUTS_VERDICT)',
    runtime: 'bun',
    with: { verdict: '$verdict.output' },
  },
  {
    name: 'script-field-binding',
    script: 'console.log(JSON.stringify({done:JSON.parse(process.env.INPUTS_DONE)}))',
    runtime: 'bun',
    with: { done: '$verdict.output.done' },
  },
  {
    name: 'script-directive-binding',
    script: 'console.log(process.env.INPUTS_VERDICT)',
    runtime: 'bun',
    with: { verdict: { from: '$verdict.output' } },
  },
  {
    name: 'script-field-directive-binding',
    script: 'console.log(JSON.stringify({done:JSON.parse(process.env.INPUTS_DONE)}))',
    runtime: 'bun',
    with: { done: { from: '$verdict.output.done' } },
  },
  {
    name: 'script-prior',
    script: 'console.log(JSON.stringify([$LOOP_PREV.verdict.output][0] ?? {done:false}))',
    runtime: 'bun',
  },
  {
    name: 'script-prior-field',
    script:
      'console.log(JSON.stringify({done:JSON.parse("$LOOP_PREV.verdict.output.done" || "false")}))',
    runtime: 'bun',
  },
  {
    name: 'script-prior-binding',
    script: 'console.log(process.env.INPUTS_VERDICT || \'{"done":false}\')',
    runtime: 'bun',
    with: { verdict: '$LOOP_PREV.verdict.output' },
  },
  {
    name: 'script-prior-field-binding',
    script: 'console.log(JSON.stringify({done:JSON.parse(process.env.INPUTS_DONE || "false")}))',
    runtime: 'bun',
    with: { done: '$LOOP_PREV.verdict.output.done' },
  },
  {
    name: 'script-fallback-binding',
    script: 'console.log(process.env.INPUTS_VERDICT || \'{"done":false}\')',
    runtime: 'bun',
    trigger_rule: 'all_done',
    with: { verdict: { from: '$absent.output', if_skipped: '$LOOP_PREV.verdict.output' } },
  },
  {
    name: 'python-binding',
    script: 'import os\nprint(os.environ["INPUTS_VERDICT"])',
    runtime: 'uv',
    with: { verdict: '$verdict.output' },
  },
  {
    name: 'named-script-binding',
    script: 'relay-copy',
    runtime: 'bun',
    with: { verdict: '$verdict.output' },
  },
  {
    name: 'typed-binding',
    script: 'console.log(JSON.stringify(JSON.parse(process.env.INPUTS_VERDICTS)[0].value))',
    runtime: 'bun',
    with: { verdicts: { outputs: 'judgment' } },
  },
] as const;

describe('dry-run executable input provenance', () => {
  test.each(relays.flatMap(relay => [false, true].map(defaultStubs => ({ relay, defaultStubs }))))(
    'generated verdict cannot be relayed by executed code: %j',
    async ({ relay, defaultStubs }) => {
      const cwd = temporaryDirectory();
      const { name, ...body } = relay;
      if (name === 'named-script-binding') {
        mkdirSync(join(cwd, '.archon', 'scripts'), { recursive: true });
        writeFileSync(
          join(cwd, '.archon', 'scripts', 'relay-copy.ts'),
          'console.log(process.env.INPUTS_VERDICT);'
        );
      }
      const result = await dryRunWorkflow({
        cwd,
        execCode: true,
        defaultStubs,
        workflow: makeTestWorkflow({
          name,
          inputs: { take: { default: 'no' } },
          nodes: [
            {
              id: 'rounds',
              loop_group: {
                max_iterations: 2,
                until_bash: 'done=$relay.output.done; test "$done" = true && touch accepted',
                nodes: [
                  ...(name === 'script-fallback-binding'
                    ? [{ id: 'absent', prompt: 'unused', when: "$INPUTS.take == 'never'" }]
                    : []),
                  {
                    id: 'verdict',
                    prompt: 'review',
                    trigger_rule: 'all_done',
                    output_format: verdictSchema,
                    output_type: 'judgment',
                  },
                  {
                    id: 'relay',
                    ...body,
                    depends_on:
                      name === 'script-fallback-binding' ? ['verdict', 'absent'] : ['verdict'],
                    output_format: verdictSchema,
                  },
                ],
              },
            },
          ],
        }),
      });
      expect(result.outcome).toBe('failed');
      expect(existsSync(join(cwd, 'accepted'))).toBe(false);
    }
  );

  test.each([false, true])(
    'generated verdict cannot be relayed through composed shell input: %s',
    async defaultStubs => {
      const cwd = temporaryDirectory();
      const block = makeTestWorkflow({
        name: 'relay-block',
        inputs: { verdict: { required: true } },
        nodes: [{ id: 'copy', bash: 'printf "%s" $INPUTS.verdict', output_format: verdictSchema }],
      });
      const parent = makeTestWorkflow({
        name: 'composed-relay',
        nodes: [
          {
            id: 'rounds',
            loop_group: {
              max_iterations: 2,
              until_bash: 'done=$relay.output.done; test "$done" = true && touch accepted',
              nodes: [
                {
                  id: 'verdict',
                  prompt: 'review',
                  trigger_rule: 'all_done',
                  output_format: verdictSchema,
                },
                {
                  id: 'relay',
                  include: 'relay-block',
                  depends_on: ['verdict'],
                  with: { verdict: '$verdict.output' },
                },
              ],
            },
          },
        ],
      });
      const result = await dryRunWorkflow({
        cwd,
        execCode: true,
        defaultStubs,
        workflow: makeTestComposedWorkflow([block, parent], 'composed-relay'),
      });
      expect(result.outcome).toBe('failed');
      expect(existsSync(join(cwd, 'accepted'))).toBe(false);
    }
  );

  test.each(['authored', 'executed'] as const)('genuine verdict still works: %s', async source => {
    const cwd = temporaryDirectory();
    const result = await dryRunWorkflow({
      cwd,
      execCode: true,
      ...(source === 'authored' ? { stubs: { verdict: { done: true } } } : {}),
      workflow: makeTestWorkflow({
        name: source,
        nodes: [
          {
            id: 'rounds',
            loop_group: {
              max_iterations: 2,
              until_bash: 'done=$relay.output.done; test "$done" = true && touch accepted',
              nodes: [
                {
                  id: 'verdict',
                  ...(source === 'authored'
                    ? { prompt: 'review' }
                    : { bash: "printf '%s' '{\"done\":true}'" }),
                  output_format: verdictSchema,
                },
                {
                  id: 'relay',
                  bash: 'printf "%s" $verdict.output',
                  depends_on: ['verdict'],
                  output_format: verdictSchema,
                },
              ],
            },
          },
        ],
      }),
    });
    expect(result.outcome).toBe('completed');
    expect(existsSync(join(cwd, 'accepted'))).toBe(true);
  });
});
