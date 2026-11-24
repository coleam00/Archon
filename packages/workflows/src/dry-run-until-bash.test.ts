// @archon-test-isolated
// @archon-test-windows
import { describe, expect, test, spyOn } from 'bun:test';
import * as git from '@archon/git';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestWorkflow } from './test-utils';
import { dryRunWorkflow, useDryRunFiles } from './dry-run-test-utils';
import { nodeOutcomesListingSchema } from './schemas/node-outcomes';
import { nodeArtifactsListingSchema } from './schemas/node-artifact';
import * as dryRunListings from './dry-run/invocation-listings';

const { temporaryDirectory } = useDryRunFiles();
const verdictSchema = {
  type: 'object',
  properties: { done: { type: 'boolean' }, note: { type: 'string' } },
  required: ['done', 'note'],
};

describe('dry-run until_bash', () => {
  test('a single-node loop completes by its actual probe exactly at the cap', async () => {
    const cwd = temporaryDirectory();
    const result = await dryRunWorkflow({
      cwd,
      execCode: true,
      workflow: makeTestWorkflow({
        name: 'single-cap',
        nodes: [
          {
            id: 'review',
            loop: {
              prompt: 'review',
              max_iterations: 3,
              until_bash:
                'printf "%s\\n" "$LOOP_PREV_OUTPUT" >> previous; test "$LOOP_PREV_OUTPUT" = ready',
            },
          },
        ],
      }),
      iterationStubs: { review: ['first', 'ready', 'accepted'] },
    });
    expect(result.outcome).toBe('completed');
    expect(result.trace[0]?.output).toBe('accepted');
    expect(readFileSync(join(cwd, 'previous'), 'utf8')).toBe('\nfirst\nready\n');
  });

  test('separate groups sharing a bare stub id select independently', async () => {
    const workflow = makeTestWorkflow({
      name: 'independent-groups',
      nodes: ['first', 'second'].map(id => ({
        id,
        loop_group: {
          max_iterations: 2,
          until_bash: 'done=$verdict.output.done; test "$done" = true',
          nodes: [{ id: 'verdict', prompt: 'review', output_format: verdictSchema }],
        },
      })),
    });
    const result = await dryRunWorkflow({
      execCode: true,
      workflow,
      iterationStubs: {
        verdict: [
          { done: false, note: 'revise' },
          { done: true, note: 'accepted' },
        ],
      },
    });
    expect(result.outcome).toBe('completed');
    expect(
      result.trace.filter(entry => entry.nodeId === 'verdict').map(entry => entry.output)
    ).toEqual([
      '{"done":false,"note":"revise"}',
      '{"done":true,"note":"accepted"}',
      '{"done":false,"note":"revise"}',
      '{"done":true,"note":"accepted"}',
    ]);
  });
  test('listing provisioning failures stop without executing a probe', async () => {
    const cwd = temporaryDirectory();
    const writer = spyOn(dryRunListings, 'writeDryRunInvocationListings').mockRejectedValueOnce(
      new Error('observation write refused')
    );
    try {
      const result = await dryRunWorkflow({
        cwd,
        execCode: true,
        workflow: makeTestWorkflow({
          name: 'listing-failure',
          nodes: [
            {
              id: 'rounds',
              loop_group: {
                max_iterations: 3,
                on_exhausted: 'complete',
                until_bash: 'touch probe',
                nodes: [{ id: 'verdict', prompt: 'review' }],
              },
            },
          ],
        }),
        stubs: { verdict: 'continue' },
      });
      expect(result.outcome).toBe('failed');
      expect(writer).toHaveBeenCalledTimes(1);
      expect(existsSync(join(cwd, 'probe'))).toBe(false);
    } finally {
      writer.mockRestore();
    }
  });
  test('large current references spill safely and retain their exact bytes', async () => {
    const cwd = temporaryDirectory();
    const note = 'quoted " $(touch injected) é'.repeat(1600);
    const result = await dryRunWorkflow({
      cwd,
      execCode: true,
      workflow: makeTestWorkflow({
        name: 'large-probe',
        nodes: [
          {
            id: 'rounds',
            loop_group: {
              max_iterations: 2,
              until_bash: 'note=$verdict.output.note; printf "%s" "$note" > received',
              nodes: [{ id: 'verdict', prompt: 'review', output_format: verdictSchema }],
            },
          },
        ],
      }),
      stubs: { verdict: { done: true, note } },
    });
    expect(result.outcome).toBe('completed');
    expect(readFileSync(join(cwd, 'received'), 'utf8')).toBe(note);
    expect(existsSync(join(cwd, 'injected'))).toBe(false);
  });

  test('invalid shell source fails without executing a prefix', async () => {
    const cwd = temporaryDirectory();
    const result = await dryRunWorkflow({
      cwd,
      execCode: true,
      workflow: makeTestWorkflow({
        name: 'invalid-probe',
        nodes: [
          {
            id: 'review',
            loop: {
              prompt: 'review',
              max_iterations: 2,
              on_exhausted: 'complete',
              until_bash: 'touch prefix\0; exit 0',
            },
          },
        ],
      }),
      stubs: { review: 'continue' },
    });
    expect(result.outcome).toBe('failed');
    expect(existsSync(join(cwd, 'prefix'))).toBe(false);
  });

  test('configured environment preserves input, engine and credential ownership', async () => {
    const cwd = temporaryDirectory();
    const protectedValue = 'private-account-value';
    const result = await dryRunWorkflow({
      cwd,
      execCode: true,
      inputs: { label: 'bound' },
      config: {
        assistant: undefined,
        assistants: { claude: {}, codex: {} },
        commands: {},
        envVars: {
          ACCOUNT: protectedValue,
          INPUTS_LABEL: 'shadow',
          WORKFLOW_ID: 'shadow',
          PWD: 'shadow',
        },
        protectedEnvKeys: ['ACCOUNT'],
        protectedCredentialValues: [protectedValue],
      },
      workflow: makeTestWorkflow({
        name: 'probe-env',
        inputs: { label: { required: true } },
        nodes: [
          {
            id: 'review',
            loop: {
              prompt: 'review',
              max_iterations: 2,
              on_exhausted: 'complete',
              until_bash:
                'test "$PWD" != shadow || exit 7; printf "%s %s" "$INPUTS_LABEL" "$WORKFLOW_ID" > environment; printf "%s" "$ACCOUNT" >&2; sleep 2',
            },
            timeout: 200,
          },
        ],
      }),
      stubs: { review: 'continue' },
    });
    expect(result.outcome).toBe('failed');
    expect(readFileSync(join(cwd, 'environment'), 'utf8')).toBe('bound dry-run');
    expect(JSON.stringify(result)).not.toContain(protectedValue);
  });

  test('unstubbed executable bodies run before their actual probe', async () => {
    const cwd = temporaryDirectory();
    writeFileSync(join(cwd, 'remaining'), 'two');
    const result = await dryRunWorkflow({
      cwd,
      execCode: true,
      defaultStubs: true,
      workflow: makeTestWorkflow({
        name: 'executable-body',
        nodes: [
          {
            id: 'rounds',
            loop_group: {
              max_iterations: 3,
              until_bash: 'test "$(cat remaining)" = done',
              nodes: [
                {
                  id: 'work',
                  bash: 'if test "$(cat remaining)" = two; then printf one > remaining; else printf done > remaining; fi; printf body >> bodies',
                },
              ],
            },
          },
        ],
      }),
    });
    expect(result.outcome).toBe('completed');
    expect(readFileSync(join(cwd, 'bodies'), 'utf8')).toBe('bodybody');
    expect(result.trace.filter(entry => entry.nodeId === 'work')).toHaveLength(2);
  });

  test.each(['fail', 'pause'] as const)('body %s prevents any completion probe', async outcome => {
    const cwd = temporaryDirectory();
    const result = await dryRunWorkflow({
      cwd,
      execCode: true,
      workflow: makeTestWorkflow({
        name: 'body-failure',
        nodes: [
          {
            id: 'rounds',
            loop_group: {
              max_iterations: 3,
              on_exhausted: 'complete',
              until_bash: 'touch probe',
              nodes:
                outcome === 'fail'
                  ? [{ id: 'work', bash: 'exit 9' }]
                  : [{ id: 'ask', wait: { attention: 'Answer' } }],
            },
          },
        ],
      }),
    });
    expect(result.outcome).toBe(outcome === 'fail' ? 'failed' : 'paused');
    expect(existsSync(join(cwd, 'probe'))).toBe(false);
  });

  test.each(['exit 0', 'exit 7'] as const)(
    'tolerated placeholder completes only on real completion: %s',
    async code => {
      const result = await dryRunWorkflow({
        execCode: true,
        workflow: makeTestWorkflow({
          name: 'tolerated-probe',
          nodes: [
            {
              id: 'review',
              trigger_rule: 'all_done',
              loop: {
                prompt: 'review',
                max_iterations: 2,
                on_exhausted: 'complete',
                until_bash: code,
              },
            },
          ],
        }),
      });
      expect(result.outcome).toBe('completed');
      expect(result.missingStubs).toEqual(['review']);
      expect(result.toleratedMissingStubs).toEqual(['review']);
    }
  );
  test('probe observations are readable, iteration-qualified and immutable', async () => {
    const cwd = temporaryDirectory();
    const result = await dryRunWorkflow({
      cwd,
      execCode: true,
      workflow: makeTestWorkflow({
        name: 'observations',
        nodes: [
          {
            id: 'rounds',
            loop_group: {
              max_iterations: 3,
              until_bash:
                'if test -f first-typed; then cmp "$(cat first-typed)" typed-0.json || exit 7; cmp "$(cat first-outcomes)" outcomes-0.json || exit 7; else printf "%s" "$TYPED_ARTIFACTS_FILE" > first-typed; printf "%s" "$NODE_OUTCOMES_FILE" > first-outcomes; fi; cp "$TYPED_ARTIFACTS_FILE" "typed-$(ls typed-* 2>/dev/null | wc -l | tr -d \' \').json"; cp "$NODE_OUTCOMES_FILE" "outcomes-$(ls outcomes-* 2>/dev/null | wc -l | tr -d \' \').json"; done=$verdict.output.done; test "$done" = true',
              nodes: [
                {
                  id: 'verdict',
                  prompt: 'review',
                  output_format: verdictSchema,
                  output_type: 'judgment',
                },
              ],
            },
          },
        ],
      }),
      iterationStubs: {
        verdict: [
          { done: false, note: 'revise' },
          { done: true, note: 'accepted' },
        ],
      },
    });
    expect(result.outcome).toBe('completed');
    const first = nodeOutcomesListingSchema.parse(
      JSON.parse(readFileSync(join(cwd, 'outcomes-0.json'), 'utf8'))
    );
    const second = nodeOutcomesListingSchema.parse(
      JSON.parse(readFileSync(join(cwd, 'outcomes-1.json'), 'utf8'))
    );
    expect(first.nodes).toEqual([
      {
        node_id: 'rounds.verdict',
        state: 'completed',
        loop_group_path: [{ groupId: 'rounds', iteration: 1 }],
        output: { done: false, note: 'revise' },
      },
    ]);
    expect(second.nodes).toHaveLength(2);
    const typed = nodeArtifactsListingSchema.parse(
      JSON.parse(readFileSync(join(cwd, 'typed-1.json'), 'utf8'))
    );
    expect(typed.runId).toBe('dry-run');
    expect(typed.artifactsByType.judgment?.map(entry => entry.loopGroupPath)).toEqual([
      [{ groupId: 'rounds', iteration: 1 }],
      [{ groupId: 'rounds', iteration: 2 }],
    ]);
  });

  test('probes resolve previous body snapshots, protected inputs and shell-safe values', async () => {
    const cwd = temporaryDirectory();
    const note = 'quoted \' " $(touch injected) ; &';
    const result = await dryRunWorkflow({
      cwd,
      execCode: true,
      inputs: { label: note },
      workflow: makeTestWorkflow({
        name: 'probe-context',
        inputs: { label: { required: true } },
        nodes: [
          {
            id: 'rounds',
            loop_group: {
              max_iterations: 3,
              until_bash:
                'printf "%s\\n" $LOOP_PREV.verdict.output.note >> prior; test $verdict.output.note = "$INPUTS_LABEL" || exit 7; done=$verdict.output.done; test "$done" = true',
              nodes: [{ id: 'verdict', prompt: 'review', output_format: verdictSchema }],
            },
          },
        ],
      }),
      iterationStubs: {
        verdict: [
          { done: false, note },
          { done: true, note },
        ],
      },
    });
    expect(result.outcome).toBe('completed');
    expect(readFileSync(join(cwd, 'prior'), 'utf8')).toBe(`\n${note}\n`);
    expect(existsSync(join(cwd, 'injected'))).toBe(false);
  });

  test('schema-valid sequences suppress executable bodies but not enabled probes', async () => {
    const cwd = temporaryDirectory();
    const result = await dryRunWorkflow({
      cwd,
      execCode: true,
      workflow: makeTestWorkflow({
        name: 'stubbed-body',
        nodes: [
          {
            id: 'rounds',
            loop_group: {
              max_iterations: 3,
              until_bash: 'touch probe; done=$verdict.output.done; test "$done" = true',
              nodes: [{ id: 'verdict', bash: 'touch body; exit 9', output_format: verdictSchema }],
            },
          },
        ],
      }),
      iterationStubs: {
        verdict: [
          { done: false, note: 'revise' },
          { done: true, note: 'accepted' },
        ],
      },
    });
    expect(result.outcome).toBe('completed');
    expect(existsSync(join(cwd, 'body'))).toBe(false);
    expect(existsSync(join(cwd, 'probe'))).toBe(true);
  });

  test.each(['field', 'signal'] as const)(
    'a satisfied %s channel short-circuits the probe',
    async channel => {
      const cwd = temporaryDirectory();
      const result = await dryRunWorkflow({
        cwd,
        execCode: true,
        workflow: makeTestWorkflow({
          name: 'short-circuit',
          nodes: [
            {
              id: 'review',
              ...(channel === 'field' ? { output_format: verdictSchema } : {}),
              loop: {
                prompt: 'review',
                max_iterations: 3,
                until_bash: 'touch probe',
                ...(channel === 'field' ? { until_field: 'done' } : { until: 'DONE' }),
              },
            },
          ],
        }),
        stubs: { review: channel === 'field' ? { done: true, note: 'accepted' } : 'DONE' },
      });
      expect(result.outcome).toBe('completed');
      expect(existsSync(join(cwd, 'probe'))).toBe(false);
    }
  );

  test.each(
    process.platform === 'win32'
      ? (['missing-reference', 'timeout'] as const)
      : (['missing-reference', 'timeout', 'signal'] as const)
  )('a fatal %s does not become exhaustion success', async kind => {
    const cwd = temporaryDirectory();
    const code =
      kind === 'missing-reference'
        ? 'test $absent.output = true'
        : kind === 'timeout'
          ? 'printf started >> invoked; sleep 1'
          : 'printf started >> invoked; kill -TERM $$';
    const result = await dryRunWorkflow({
      cwd,
      execCode: true,
      workflow: makeTestWorkflow({
        name: 'fatal-probe',
        nodes: [
          {
            id: 'review',
            ...(kind === 'timeout' ? { timeout: 200 } : {}),
            loop: {
              prompt: 'review',
              max_iterations: 3,
              on_exhausted: 'complete',
              until_bash: code,
            },
          },
        ],
      }),
      stubs: { review: 'continue' },
    });
    expect(result.outcome).toBe('failed');
    if (kind !== 'missing-reference')
      expect(readFileSync(join(cwd, 'invoked'), 'utf8')).toBe('started');
  });

  test('an unavailable shell fails before the cap', async () => {
    const resolver = spyOn(git, 'resolveBashPath').mockReturnValue(
      join(temporaryDirectory(), 'absent-shell')
    );
    try {
      const result = await dryRunWorkflow({
        execCode: true,
        workflow: makeTestWorkflow({
          name: 'absent-shell',
          nodes: [
            {
              id: 'review',
              loop: {
                prompt: 'review',
                max_iterations: 3,
                on_exhausted: 'complete',
                until_bash: 'exit 0',
              },
            },
          ],
        }),
        stubs: { review: 'continue' },
      });
      expect(result.outcome).toBe('failed');
      expect(resolver).toHaveBeenCalledTimes(1);
    } finally {
      resolver.mockRestore();
    }
  });

  test.each([false, true])(
    'generated defaults %s never fabricate probe success',
    async defaultStubs => {
      const result = await dryRunWorkflow({
        execCode: true,
        defaultStubs,
        workflow: makeTestWorkflow({
          name: 'generated-probe',
          nodes: [
            {
              id: 'review',
              trigger_rule: 'all_done',
              loop: {
                prompt: 'review',
                max_iterations: 2,
                until_bash: 'exit 7',
              },
            },
          ],
        }),
      });
      expect(result.outcome).toBe('failed');
      expect(result.toleratedMissingStubs).toEqual([]);
      expect(result.missingStubs).toEqual(defaultStubs ? [] : ['review']);
    }
  );
  test('uses current body output and real exit status across iterations', async () => {
    const cwd = temporaryDirectory();
    const result = await dryRunWorkflow({
      cwd,
      execCode: true,
      workflow: makeTestWorkflow({
        name: 'probe-group',
        nodes: [
          {
            id: 'rounds',
            loop_group: {
              max_iterations: 4,
              until_bash:
                'printf "probe\\n" >> probes; done=$verdict.output.done; test "$done" = true',
              nodes: [{ id: 'verdict', prompt: 'review', output_format: verdictSchema }],
            },
          },
          { id: 'after', prompt: 'final $rounds.output', depends_on: ['rounds'] },
        ],
      }),
      iterationStubs: {
        verdict: [
          { done: false, note: 'revise' },
          { done: true, note: 'accepted' },
        ],
      },
      stubs: { after: 'received' },
    });
    expect(result.outcome).toBe('completed');
    expect(
      result.trace.filter(entry => entry.nodeId === 'verdict').map(entry => entry.output)
    ).toEqual(['{"done":false,"note":"revise"}', '{"done":true,"note":"accepted"}']);
    expect(readFileSync(join(cwd, 'probes'), 'utf8')).toBe('probe\nprobe\n');
    expect(result.trace.at(-1)?.resolvedText).toContain('accepted');
  });

  test.each([false, undefined])('execution %s never invokes a probe', async execCode => {
    const cwd = temporaryDirectory();
    const result = await dryRunWorkflow({
      cwd,
      execCode,
      workflow: makeTestWorkflow({
        name: 'disabled-probe',
        nodes: [
          {
            id: 'review',
            loop: {
              prompt: 'review',
              max_iterations: 3,
              until_bash: 'touch probe; exit 7',
            },
          },
        ],
      }),
      stubs: { review: 'continue' },
    });
    expect(result.outcome).toBe('completed');
    expect(existsSync(join(cwd, 'probe'))).toBe(false);
  });

  test.each(['fail', 'complete'] as const)(
    'single-node probes honor the cap and on_exhausted: %s',
    async onExhausted => {
      const cwd = temporaryDirectory();
      const result = await dryRunWorkflow({
        cwd,
        execCode: true,
        workflow: makeTestWorkflow({
          name: 'probe-cap',
          nodes: [
            {
              id: 'review',
              loop: {
                prompt: 'review',
                max_iterations: 3,
                on_exhausted: onExhausted,
                until_bash: 'printf "%s\\n" "$LOOP_PREV_OUTPUT" >> previous; exit 7',
              },
            },
          ],
        }),
        iterationStubs: { review: ['first', 'last'] },
      });
      expect(result.outcome).toBe(onExhausted === 'complete' ? 'completed' : 'failed');
      expect(readFileSync(join(cwd, 'previous'), 'utf8')).toBe('\nfirst\nlast\n');
      if (onExhausted === 'complete') expect(result.trace.at(-1)?.output).toBe('last');
    }
  );
});
