// @archon-test-isolated
import { expect, beforeEach, afterEach, describe, it } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { execFileAsync, resolveBashPath } from '@archon/git';
import type { NodeOutput } from '../schemas';
import { executeDagWorkflow } from '../dag-executor';
import { OutputRefError } from '../output-ref';
import {
  type ShellInputContext,
  resolveNodeBindings,
  substituteNodeOutputRefs as substituteNodeOutputRefsInScopes,
} from './references';
import { type LoopBodyScope, substituteLoopBodyText } from './loop-scope';
import {
  makeOutput,
  substituteNodeOutputRefs,
  dagOptions,
  createMockDeps,
  createMockStore,
  createMockPlatform,
  makeWorkflowRun,
  mockLogFn,
} from './test-utils';

describe('output reference errors name the reference as written', () => {
  const ctx = (nodeOutputs: Map<string, NodeOutput>): ShellInputContext => ({
    workflowRun: { id: 'run', user_message: '', metadata: {} },
    artifactsDir: '/artifacts',
    stateDir: '/state',
    baseBranch: 'main',
    docsDir: 'docs',
    nodeOutputs,
    loopBodyScopes: [],
  });
  const producer = new Map([['p', makeOutput('completed', '{"a":{}}')]]);

  it('whole-value and directive bindings', () => {
    expect(() =>
      resolveNodeBindings('c', { v: '$p.output.a.b' }, ctx(producer), undefined)
    ).toThrow("'$p.output.a.b'");
    expect(() =>
      resolveNodeBindings('c', { v: { from: '$p.output.a.b' } }, ctx(producer), undefined)
    ).toThrow("'$p.output.a.b'");
    expect(() =>
      resolveNodeBindings('c', { v: '$ghost.output.a' }, ctx(new Map()), undefined)
    ).toThrow("'$ghost.output.a'");
  });

  it('unknown producers in current and prior templates', () => {
    expect(() => substituteNodeOutputRefs('x $ghost.output.a', new Map())).toThrow(
      "'$ghost.output.a'"
    );
    expect(() =>
      substituteLoopBodyText('$LOOP_PREV.ghost.output.x', [
        { loopPrevOutputs: new Map(), knownBodyIds: new Set(['work']) },
      ])
    ).toThrow("'$LOOP_PREV.ghost.output.x'");
  });

  it('outcome_field', async () => {
    const testDir = join(
      tmpdir(),
      `dag-outcome-ref-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    try {
      await expect(
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(createMockStore()),
            platform: createMockPlatform(),
            cwd: testDir,
            workflow: {
              name: 'outcome-ref',
              returns: 'r',
              outcome_field: 'green',
              nodes: [{ id: 'r', kind: 'exec', runtime: 'sh', script: "printf '%s' '{}'" }],
            },
            workflowRun: makeWorkflowRun('outcome-ref'),
          })
        )
      ).rejects.toThrow("'$r.output.green'");
    } finally {
      await removeTempTree(testDir);
    }
  });
});

describe('substituteNodeOutputRefs', () => {
  it('replaces $nodeId.output with node output text', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello')]]);
    expect(substituteNodeOutputRefs('Result: $a.output', outputs)).toBe('Result: hello');
  });

  it('unknown node ref resolves to empty string and logs a warning', () => {
    mockLogFn.mockClear();
    const outputs = new Map<string, NodeOutput>();
    expect(substituteNodeOutputRefs('Result: $missing.output', outputs)).toBe('Result: ');
    const warnCalls = mockLogFn.mock.calls.filter(
      (call: unknown[]) => call[1] === 'dag_node_output_ref_unknown_node'
    );
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]?.[0]).toEqual(expect.objectContaining({ nodeId: 'missing' }));
  });

  it('required mode rejects a missing whole-output ref with consumer context and a hint', () => {
    const outputs = new Map([['analyze', makeOutput('completed', 'ready')]]);

    expect(() =>
      substituteNodeOutputRefs('test $analze.output = ready', outputs, true, undefined, {
        consumerId: 'review-loop',
        field: 'loop_group.until_bash',
      })
    ).toThrow(
      "Node 'review-loop' field 'loop_group.until_bash' cannot resolve '$analze.output': node 'analze' has not produced output at this point. Did you mean: 'analyze'?"
    );
  });

  it.each(['skipped', 'pending'] as const)(
    'required mode rejects a %s whole-output producer instead of fabricating empty text',
    state => {
      const outputs = new Map([['probe', makeOutput(state)]]);

      expect(() =>
        substituteNodeOutputRefs('test $probe.output != pending', outputs, true, undefined, {
          consumerId: 'poll',
          field: 'loop.until_bash',
        })
      ).toThrow(
        "Node 'poll' field 'loop.until_bash' cannot resolve '$probe.output': node 'probe' did not run"
      );
    }
  );

  it('required mode rejects a failed whole-output producer with the owning loop context', () => {
    const outputs = new Map([['probe', makeOutput('failed', 'stale')]]);

    expect(() =>
      substituteNodeOutputRefs('test $probe.output = done', outputs, true, undefined, {
        consumerId: 'poll',
        field: 'loop.until_bash',
      })
    ).toThrow(
      "Node 'poll' field 'loop.until_bash' cannot resolve '$probe.output': node 'probe' failed (error)"
    );
  });

  it('required mode preserves a completed producer whose real output is empty', () => {
    const outputs = new Map([['probe', makeOutput('completed', '')]]);

    expect(
      substituteNodeOutputRefs('test -z $probe.output', outputs, true, undefined, {
        consumerId: 'poll',
        field: 'loop.until_bash',
      })
    ).toBe("test -z ''");
  });

  it('required mode preserves an absent field declared optional by the producer', () => {
    const outputs = new Map([
      [
        'probe',
        makeOutput('completed', '{"state":"pending"}', { state: 'pending' }, ['state', 'note']),
      ],
    ]);

    expect(
      substituteNodeOutputRefs('test -z $probe.output.note', outputs, true, undefined, {
        consumerId: 'poll',
        field: 'loop.until_bash',
      })
    ).toBe("test -z ''");
  });

  it('dot notation extracts JSON field', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ type: 'BUG' }))]]);
    expect(substituteNodeOutputRefs('Fix $a.output.type issue', outputs)).toBe('Fix BUG issue');
  });

  it('keeps literal text that touches a reference', () => {
    const outputs = new Map([['x', makeOutput('completed', '{"f":"ok"}')]]);
    expect(substituteNodeOutputRefs('**$x.output.f**', outputs)).toBe('**ok**');
    expect(substituteNodeOutputRefs('$x.outputs', outputs)).toBe('{"f":"ok"}s');
    expect(substituteNodeOutputRefs('$x.output_text', outputs)).toBe('{"f":"ok"}_text');
    expect(substituteNodeOutputRefs('Done: $x.output.', outputs)).toBe('Done: {"f":"ok"}.');
    // Only a field path can continue into nested syntax; a whole-output ref never does.
    expect(substituteNodeOutputRefs('$x.output(see)', outputs)).toBe('{"f":"ok"}(see)');
    expect(substituteNodeOutputRefs('$x.output+1', outputs)).toBe('{"f":"ok"}+1');
    expect(substituteNodeOutputRefs('**$x.output.**', outputs)).toBe('**{"f":"ok"}.**');
  });

  it('substitutes the complete nested output path', () => {
    const outputs = new Map([
      [
        'review',
        makeOutput(
          'completed',
          JSON.stringify({ proposal: { action: 'add', text: 'rule' } }),
          { proposal: { action: 'add', text: 'rule' } },
          undefined
        ),
      ],
    ]);

    expect(substituteNodeOutputRefs('Proposed: $review.output.proposal.action', outputs)).toBe(
      'Proposed: add'
    );
  });

  it('rejects an unsupported output suffix before current or prior substitution', () => {
    const outputs = new Map([['review', makeOutput('completed', '{"proposal":{"action":"add"}}')]]);
    const current = '$review.output.proposal.action[0]';
    const prior = '$LOOP_PREV.review.output.proposal.action[0]';
    expect(() => substituteNodeOutputRefs(`Proposed: ${current}`, outputs)).toThrow(
      'Unsupported output reference'
    );
    expect(() =>
      substituteLoopBodyText(`Proposed: ${prior}`, [{ loopPrevOutputs: outputs }])
    ).toThrow('Unsupported output reference');
    expect(() => substituteLoopBodyText(prior, [{ loopPrevOutputs: undefined }])).toThrow(
      'Unsupported output reference'
    );
  });

  it('retains the owning loop context when required substitution rejects a nested path', () => {
    expect(() =>
      substituteNodeOutputRefs(
        'test $review.output.proposal.action = add',
        new Map(),
        true,
        undefined,
        { consumerId: 'review-loop', field: 'loop_group.until_bash' }
      )
    ).toThrow(
      "Node 'review-loop' field 'loop_group.until_bash' cannot resolve '$review.output.proposal.action'"
    );
  });

  it('dot notation on invalid JSON throws (no-silent-drop)', () => {
    // Schemaless node, output is not a JSON object → a `.field` ref is a drop the
    // author must see. Throws (propagates to fail the consuming node) instead of ''.
    const outputs = new Map([['a', makeOutput('completed', 'not-json')]]);
    expect(() => substituteNodeOutputRefs('$a.output.field', outputs)).toThrow(OutputRefError);
  });

  it('declared-optional field absent resolves to empty (the one non-throw case)', () => {
    const outputs = new Map([
      ['a', makeOutput('completed', '{"type":"BUG"}', { type: 'BUG' }, ['type', 'note'])],
    ]);
    expect(substituteNodeOutputRefs('$a.output.note', outputs)).toBe('');
  });

  it('field not in the declared schema throws (typo)', () => {
    const outputs = new Map([
      ['a', makeOutput('completed', '{"type":"BUG"}', { type: 'BUG' }, ['type'])],
    ]);
    expect(() => substituteNodeOutputRefs('$a.output.tpye', outputs)).toThrow(OutputRefError);
  });

  it('schemaless JSON node missing a referenced key throws', () => {
    const outputs = new Map([['a', makeOutput('completed', '{"type":"BUG"}')]]);
    expect(() => substituteNodeOutputRefs('$a.output.missing', outputs)).toThrow(OutputRefError);
  });

  it('unknown node ref WITH a field throws (no-silent-drop, unknown-node)', () => {
    // The whole-text `$missing.output` form stays lenient ('' — see test above), but a
    // `.field` ref to an unknown id can still reach the executor through a programmatically
    // constructed definition that bypasses discovery. It must fail the consuming node
    // loudly, matching known-producer strict-field posture.
    const outputs = new Map([['analyze', makeOutput('completed', '{"type":"BUG"}')]]);
    let caught: unknown;
    try {
      substituteNodeOutputRefs('Fix $analze.output.type', outputs);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OutputRefError);
    expect((caught as OutputRefError).reason).toBe('unknown-node');
    // did-you-mean names the near miss.
    expect((caught as OutputRefError).message).toContain("'analyze'");
  });

  it('unknown node ref WITH a field throws even in bash-escaped mode', () => {
    const outputs = new Map<string, NodeOutput>();
    expect(() => substituteNodeOutputRefs('echo $missing.output.field', outputs, true)).toThrow(
      OutputRefError
    );
  });

  it('required mode preserves the field error cause and nearby-id hint', () => {
    const outputs = new Map([['analyze', makeOutput('completed', '{"state":"done"}')]]);
    let caught: unknown;

    try {
      substituteNodeOutputRefs('test $analze.output.state = done', outputs, true, undefined, {
        consumerId: 'poll',
        field: 'loop_group.until_bash',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(
      "Node 'poll' field 'loop_group.until_bash' cannot resolve '$analze.output.state'"
    );
    expect(message).toContain(
      "references node 'analze', but no node with that id has produced output"
    );
    expect(message).toContain("Did you mean: 'analyze'?");
  });

  it('failed producer (#2713): whole-text $node.output throws instead of splicing stale output', () => {
    // Mirrors a loop_group's failure paths: real, non-empty leftover text — not the
    // '' a plain node's failure usually leaves — must never be spliced into a
    // consumer's prompt/bash body as though the producer had succeeded.
    const outputs = new Map([['corrections', makeOutput('failed', 'CORRECTIONS_APPLIED')]]);
    expect(() => substituteNodeOutputRefs('Result: $corrections.output', outputs)).toThrow();
  });

  it('failed producer (#2713): fielded $node.output.field throws even on valid JSON leftover output', () => {
    const outputs = new Map([
      ['corrections', makeOutput('failed', JSON.stringify({ ready: true }))],
    ]);
    let caught: unknown;
    try {
      substituteNodeOutputRefs('$corrections.output.ready', outputs);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OutputRefError);
    expect((caught as OutputRefError).reason).toBe('producer-failed');
  });
});

describe('substituteNodeOutputRefs -- shell escaping', () => {
  it('shell-quotes a previous-iteration output without reading it as a reference (#4046)', () => {
    const outputs = new Map([['a', makeOutput('completed', 'A')]]);
    const scopes: LoopBodyScope[] = [
      { loopPrevOutputs: new Map([['draft', makeOutput('completed', "it's $a.output")]]) },
    ];
    expect(
      substituteNodeOutputRefsInScopes(
        'echo $LOOP_PREV.draft.output $a.output',
        outputs,
        scopes,
        true
      )
    ).toBe("echo 'it'\\''s $a.output' 'A'");
  });

  it('does not escape by default (AI prompt substitution)', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello; rm -rf /')]]);
    expect(substituteNodeOutputRefs('Result: $a.output', outputs)).toBe('Result: hello; rm -rf /');
  });

  it('shell-quotes output when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello world')]]);
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe("echo 'hello world'");
  });

  it('escapes shell metacharacters when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello; rm -rf /')]]);
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe(
      "echo 'hello; rm -rf /'"
    );
  });

  it('escapes single quotes inside output when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', "it's alive")]]);
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe("echo 'it'\\''s alive'");
  });

  it('missing ref becomes empty string when escapedForBash=true', () => {
    const outputs = new Map<string, NodeOutput>();
    expect(substituteNodeOutputRefs('echo $missing.output', outputs, true)).toBe("echo ''");
  });

  it('JSON field escapes shell metacharacters when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ cmd: 'foo; bar' }))]]);
    expect(substituteNodeOutputRefs('echo $a.output.cmd', outputs, true)).toBe("echo 'foo; bar'");
  });

  it('numeric JSON field is not quoted (safe as-is)', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ count: 42 }))]]);
    expect(substituteNodeOutputRefs('exit $a.output.count', outputs, true)).toBe('exit 42');
  });

  it('boolean JSON field is not quoted (safe as-is)', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ ok: true }))]]);
    expect(substituteNodeOutputRefs('[ $a.output.ok ]', outputs, true)).toBe('[ true ]');
  });

  it('empty string output becomes quoted empty string when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', '')]]);
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe("echo ''");
  });

  it('embedded newline in output is safe when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello\nworld')]]);
    // Single-quoted bash strings can contain literal newlines safely
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe("echo 'hello\nworld'");
  });

  it('object JSON field becomes JSON stringified when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ nested: { x: 1 } }))]]);
    expect(substituteNodeOutputRefs('echo $a.output.nested', outputs, true)).toBe(
      'echo \'{"x":1}\''
    );
  });

  it('array JSON field becomes JSON stringified', () => {
    const outputs = new Map([
      ['a', makeOutput('completed', JSON.stringify({ items: ['todo', 'fix'] }))],
    ]);
    expect(substituteNodeOutputRefs('$a.output.items', outputs)).toBe('["todo","fix"]');
  });

  it('array JSON field is shell-quoted when escapedForBash=true', () => {
    const outputs = new Map([
      ['a', makeOutput('completed', JSON.stringify({ items: ['todo', 'fix'] }))],
    ]);
    expect(substituteNodeOutputRefs('echo $a.output.items', outputs, true)).toBe(
      'echo \'["todo","fix"]\''
    );
  });

  it('nested object in array field becomes JSON stringified', () => {
    const outputs = new Map([
      [
        'a',
        makeOutput('completed', JSON.stringify({ files: [{ name: 'a.ts', status: 'modified' }] })),
      ],
    ]);
    expect(substituteNodeOutputRefs('$a.output.files', outputs)).toBe(
      '[{"name":"a.ts","status":"modified"}]'
    );
  });

  it('null values in arrays stringify to "null"', () => {
    const outputs = new Map([
      ['a', makeOutput('completed', JSON.stringify({ items: [null, 'ok'] }))],
    ]);
    expect(substituteNodeOutputRefs('$a.output.items', outputs)).toBe('[null,"ok"]');
  });

  it('null object field becomes JSON stringified "null"', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ config: null }))]]);
    expect(substituteNodeOutputRefs('$a.output.config', outputs)).toBe('null');
  });

  it('dot notation on invalid JSON throws even when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', 'not-json')]]);
    expect(() => substituteNodeOutputRefs('$a.output.field', outputs, true)).toThrow(
      OutputRefError
    );
  });
});

describe('substituteNodeOutputRefs -- large output file substitution', () => {
  let tempDir: string;

  const spillPath = async (artifactsDir: string, filename: string): Promise<string> => {
    const root = join(artifactsDir, '.archon', 'node-output-spills');
    const files = await readdir(root);
    const file = files.find(file => file.endsWith(`.${filename}`));
    if (!file) throw new Error(`Missing spill ${filename}`);
    return join(root, file);
  };

  beforeEach(async () => {
    tempDir = join(tmpdir(), `archon-test-large-output-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(tempDir);
  });

  it('inlines small output even when outputFileDir is provided', () => {
    const outputs = new Map([['a', makeOutput('completed', 'small')]]);
    const result = substituteNodeOutputRefs('echo $a.output', outputs, true, tempDir);
    expect(result).toBe("echo 'small'");
  });

  it('writes output above 32KB to file and returns $(cat ...) reference', async () => {
    const largeOutput = 'x'.repeat(33_000);
    const outputs = new Map([['a', makeOutput('completed', largeOutput)]]);
    const result = substituteNodeOutputRefs('echo $a.output', outputs, true, tempDir);
    expect(result).toContain('$(cat ');
    expect(result).toContain('a.nodeoutput');
    // Verify file was written with correct content
    const { readFile: readFileAsync } = await import('fs/promises');
    const written = await readFileAsync(await spillPath(tempDir, 'a.nodeoutput'), 'utf-8');
    expect(written).toBe(largeOutput);
  });

  it.each(['', '\n', '\n\n'])(
    'inlines multibyte output below the code-unit threshold with suffix %j',
    suffix => {
      const output = 'é'.repeat(20_000) + suffix;
      expect(output.length).toBeLessThan(32_768);
      expect(Buffer.byteLength(output, 'utf8')).toBeGreaterThan(32_768);
      expect(
        substituteNodeOutputRefs(
          'echo $a.output',
          new Map([['a', makeOutput('completed', output)]]),
          true,
          tempDir
        )
      ).toBe(`echo '${output}'`);
    }
  );

  it('inlines output at the UTF-16 code-unit threshold', () => {
    const output = 'é'.repeat(32_768);
    expect(
      substituteNodeOutputRefs(
        'echo $a.output',
        new Map([['a', makeOutput('completed', output)]]),
        true,
        tempDir
      )
    ).toBe(`echo '${output}'`);
  });

  it.each([
    { label: 'spilled ASCII output', value: 'x'.repeat(33_000) },
    { label: 'spilled multibyte output', value: 'é'.repeat(33_000) },
  ])('delivers $label exactly through all four shell output references', async ({ value }) => {
    const outputs = new Map([['a', makeOutput('completed', value, { data: value })]]);
    const script = substituteNodeOutputRefsInScopes(
      'current=$a.output; field=$a.output.data; previous=$LOOP_PREV.a.output; prior_field=$LOOP_PREV.a.output.data; ' +
        'printf "%s|%s|%s|%s" "$current" "$field" "$previous" "$prior_field"',
      outputs,
      [{ loopPrevOutputs: outputs, outputFileDir: tempDir }],
      true,
      tempDir
    );
    const { stdout } = await execFileAsync(resolveBashPath(), ['-c', script], {
      maxBuffer: 4_000_000,
    });
    expect(stdout).toBe([value, value, value, value].join('|'));
  });

  it.each(['', '.data'])(
    'gives equal current and previous %s values separate files',
    async field => {
      const value = 'same'.repeat(10_000);
      const outputs = new Map([['a', makeOutput('completed', value, { data: value })]]);
      const script = substituteNodeOutputRefsInScopes(
        `current=$a.output${field}; previous=$LOOP_PREV.a.output${field}; printf '%s|%s' "$current" "$previous"`,
        outputs,
        [{ loopPrevOutputs: outputs, outputFileDir: tempDir }],
        true,
        tempDir
      );
      const root = join(tempDir, '.archon', 'node-output-spills');
      const files = (await readdir(root, { recursive: true })).filter(file =>
        file.endsWith('.nodeoutput')
      );
      expect(files).toHaveLength(2);
      expect(files[0]).not.toBe(files[1]);
      const { stdout } = await execFileAsync(resolveBashPath(), ['-c', script]);
      expect(stdout).toBe(`${value}|${value}`);
    }
  );

  it('writes large field value to file with field name in filename', async () => {
    const largeValue = 'y'.repeat(33_000);
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ data: largeValue }))]]);
    const result = substituteNodeOutputRefs('echo $a.output.data', outputs, true, tempDir);
    expect(result).toContain('$(cat ');
    expect(result).toContain('a.data.nodeoutput');
    const { readFile: readFileAsync } = await import('fs/promises');
    const written = await readFileAsync(await spillPath(tempDir, 'a.data.nodeoutput'), 'utf-8');
    expect(written).toBe(largeValue);
  });

  it('does not overwrite a workflow-authored root artifact with the same filename', async () => {
    const workflowArtifact = join(tempDir, 'a.nodeoutput');
    await writeFile(workflowArtifact, 'workflow-owned');
    const largeOutput = 'x'.repeat(33_000);

    substituteNodeOutputRefs(
      'echo $a.output',
      new Map([['a', makeOutput('completed', largeOutput)]]),
      true,
      tempDir
    );

    expect(await readFile(workflowArtifact, 'utf-8')).toBe('workflow-owned');
    expect(await readFile(await spillPath(tempDir, 'a.nodeoutput'), 'utf-8')).toBe(largeOutput);
  });

  it('keeps same-node spills isolated in separate run artifact directories', async () => {
    const runAArtifacts = join(tempDir, 'run-a');
    const runBArtifacts = join(tempDir, 'run-b');
    await Promise.all([
      mkdir(runAArtifacts, { recursive: true }),
      mkdir(runBArtifacts, { recursive: true }),
    ]);
    const runAOutput = 'a'.repeat(33_000);
    const runBOutput = 'b'.repeat(33_000);

    const runACommand = substituteNodeOutputRefs(
      'printf %s $build.output',
      new Map([['build', makeOutput('completed', runAOutput)]]),
      true,
      runAArtifacts
    );
    const runBCommand = substituteNodeOutputRefs(
      'printf %s $build.output',
      new Map([['build', makeOutput('completed', runBOutput)]]),
      true,
      runBArtifacts
    );

    expect(runACommand).not.toBe(runBCommand);
    expect(runACommand).toContain(await spillPath(runAArtifacts, 'build.nodeoutput'));
    expect(runBCommand).toContain(await spillPath(runBArtifacts, 'build.nodeoutput'));
    expect(await readFile(await spillPath(runAArtifacts, 'build.nodeoutput'), 'utf-8')).toBe(
      runAOutput
    );
    expect(await readFile(await spillPath(runBArtifacts, 'build.nodeoutput'), 'utf-8')).toBe(
      runBOutput
    );
  });

  it('does not write to file when escapedForBash=false even for large output', () => {
    const largeOutput = 'x'.repeat(33_000);
    const outputs = new Map([['a', makeOutput('completed', largeOutput)]]);
    const result = substituteNodeOutputRefs('echo $a.output', outputs, false, tempDir);
    expect(result).toBe(`echo ${largeOutput}`);
    expect(result).not.toContain('$(cat ');
  });

  it('falls back to shell-quoting when file write fails', async () => {
    const largeOutput = 'x'.repeat(33_000);
    const outputs = new Map([['a', makeOutput('completed', largeOutput)]]);
    // A regular file cannot contain the engine spill child on any platform.
    const badDir = join(tempDir, 'not-a-directory');
    await writeFile(badDir, 'occupied');
    const result = substituteNodeOutputRefs('echo $a.output', outputs, true, badDir);
    // Should fall back to inline shell-quoting instead of crashing
    expect(result).not.toContain('$(cat ');
    expect(result).toBe(`echo '${largeOutput}'`);
  });
});

describe('substituteNodeOutputRefs -- structuredOutput preference', () => {
  it('prefers structuredOutput.field over JSON.parse(output)', () => {
    // Pi-shape: prose output text with structuredOutput populated by tryParseStructuredOutput.
    const outputs = new Map([
      [
        'classify',
        makeOutput('completed', 'Here is the classification: {"type":"WRONG"}', {
          type: 'BUG',
          confidence: 0.9,
        }),
      ],
    ]);
    expect(substituteNodeOutputRefs('Fix $classify.output.type issue', outputs)).toBe(
      'Fix BUG issue'
    );
  });

  it('falls back to JSON.parse(output) when structuredOutput is absent', () => {
    // Claude/Codex backward-compat regression: no structuredOutput, JSON in `output`.
    const outputs = new Map([
      ['classify', makeOutput('completed', JSON.stringify({ type: 'BUG' }))],
    ]);
    expect(substituteNodeOutputRefs('Fix $classify.output.type issue', outputs)).toBe(
      'Fix BUG issue'
    );
  });

  it('coerces structuredOutput numeric field to string', () => {
    const outputs = new Map([['score', makeOutput('completed', '', { confidence: 0.95 })]]);
    expect(substituteNodeOutputRefs('score=$score.output.confidence', outputs)).toBe('score=0.95');
  });

  it('coerces structuredOutput boolean field to string', () => {
    const outputs = new Map([['n', makeOutput('completed', '', { ok: true })]]);
    expect(substituteNodeOutputRefs('[ $n.output.ok ]', outputs)).toBe('[ true ]');
  });

  it('JSON-stringifies object structuredOutput field', () => {
    const outputs = new Map([['n', makeOutput('completed', '', { nested: { x: 1 } })]]);
    expect(substituteNodeOutputRefs('$n.output.nested', outputs)).toBe('{"x":1}');
  });

  it('JSON-stringifies array structuredOutput field', () => {
    const outputs = new Map([['n', makeOutput('completed', '', { items: ['todo', 'fix'] })]]);
    expect(substituteNodeOutputRefs('$n.output.items', outputs)).toBe('["todo","fix"]');
  });

  it('works with empty output text (Pi-only-structured case)', () => {
    // structuredOutput populated, output text empty → dot-access still works.
    const outputs = new Map([['classify', makeOutput('completed', '', { type: 'BUG' })]]);
    expect(substituteNodeOutputRefs('Fix $classify.output.type issue', outputs)).toBe(
      'Fix BUG issue'
    );
  });

  it('null structuredOutput falls through to JSON.parse fallback', () => {
    const outputs = new Map([
      ['n', makeOutput('completed', JSON.stringify({ type: 'BUG' }), null)],
    ]);
    expect(substituteNodeOutputRefs('$n.output.type', outputs)).toBe('BUG');
  });

  it('top-level-array structuredOutput falls through to JSON.parse fallback', () => {
    const outputs = new Map([
      ['n', makeOutput('completed', JSON.stringify({ type: 'BUG' }), [1, 2, 3])],
    ]);
    expect(substituteNodeOutputRefs('$n.output.type', outputs)).toBe('BUG');
  });

  it('primitive structuredOutput falls through to JSON.parse fallback', () => {
    const outputs = new Map([
      ['n', makeOutput('completed', JSON.stringify({ type: 'BUG' }), 'just-a-string')],
    ]);
    expect(substituteNodeOutputRefs('$n.output.type', outputs)).toBe('BUG');
  });

  it('missing field in structuredOutput resolves to empty string (no JSON.parse retry)', () => {
    // structuredOutput is authoritative; if the field is missing, do not retry output.
    const outputs = new Map([
      ['classify', makeOutput('completed', JSON.stringify({ type: 'BUG' }), { confidence: 0.9 })],
    ]);
    expect(substituteNodeOutputRefs('Fix $classify.output.type issue', outputs)).toBe('Fix  issue');
  });

  it('bare $node.output reference (no field) uses output text, not structuredOutput', () => {
    const outputs = new Map([['n', makeOutput('completed', 'prose text', { type: 'BUG' })]]);
    expect(substituteNodeOutputRefs('Got: $n.output', outputs)).toBe('Got: prose text');
  });

  it('structuredOutput field is shell-quoted when escapedForBash=true', () => {
    const outputs = new Map([['n', makeOutput('completed', '', { cmd: 'foo; bar' })]]);
    expect(substituteNodeOutputRefs('echo $n.output.cmd', outputs, true)).toBe("echo 'foo; bar'");
  });
});
