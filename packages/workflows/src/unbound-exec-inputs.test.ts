import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { parseWorkflow } from './loader';
import { discoverWorkflows } from './workflow-discovery';

const trackTempRoot = trackTempRoots();

async function createProject(): Promise<string> {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-unbound-exec-inputs-')));
  await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
  await mkdir(join(root, '.archon', 'scripts'), { recursive: true });
  return root;
}

describe('unbound exec input reads', () => {
  test('recognizes each supported Python, JavaScript, and bash read form', () => {
    const result = parseWorkflow(
      `name: supported-forms
description: Exercise every supported static environment accessor
inputs:
  declared: {}
nodes:
  - id: python
    script: |
      print(os.environ["INPUTS_PY_BRACKET"])
      print(os.environ['INPUTS_PY_SINGLE'])
      print(os.environ.get('INPUTS_PY_GET', ''))
    runtime: uv
  - id: javascript
    script: |
      console.log(process.env.INPUTS_JS_DOT)
      console.log(process.env['INPUTS_JS_BRACKET'])
      console.log(process.env["INPUTS_JS_DOUBLE"])
    runtime: bun
  - id: shell
    bash: |
      printf '%s' "$INPUTS_BASH_BARE"
      printf '%s' "\${INPUTS_BASH_BRACED}"
`,
      'supported-forms.yaml'
    );

    expect(result.workflow).toBeNull();
    for (const name of [
      'INPUTS_PY_BRACKET',
      'INPUTS_PY_SINGLE',
      'INPUTS_PY_GET',
      'INPUTS_JS_DOT',
      'INPUTS_JS_BRACKET',
      'INPUTS_JS_DOUBLE',
      'INPUTS_BASH_BARE',
      'INPUTS_BASH_BRACED',
    ]) {
      expect(result.error?.error).toContain(name);
    }
    expect(result.error?.error).toContain('script line 1');
    expect(result.error?.error).toContain('script line 2');
    expect(result.error?.error).toContain('bash line 1');
    expect(result.error?.error).toContain('bash line 2');
  });

  test('accepts script bindings, declared inputs, and engine-owned variables', () => {
    const result = parseWorkflow(
      `name: provided-values
description: Accept every environment source the engine owns
inputs:
  declared_name:
    default: value
nodes:
  - id: produce
    prompt: Produce a value
    output_format:
      type: object
      properties:
        value: { type: string }
      required: [value]
  - id: verify
    depends_on: [produce]
    script: |
      console.log(process.env.INPUTS_LITERAL)
      console.log(process.env.INPUTS_DIRECTIVE)
      console.log(process.env.INPUTS_DECLARED_NAME)
      console.log(process.env.ARTIFACTS_DIR)
      console.log(process.env.STATE_DIR)
      console.log(process.env.LOG_DIR)
      console.log(process.env.BASE_BRANCH)
      console.log(process.env.ARGUMENTS)
      console.log(process.env.WORKFLOW_ID)
    runtime: bun
    with:
      literal: true
      directive: { from: $produce.output.value, if_skipped: fallback }
`,
      'provided-values.yaml'
    );

    expect(result.workflow).not.toBeNull();
    expect(result.warnings).toEqual([]);
  });

  test('bash reads can use declared inputs but not an ignored local with binding', () => {
    const declared = parseWorkflow(
      `name: bash-declared
description: A bash input comes from the workflow declaration
inputs:
  ready:
    default: yes
nodes:
  - id: verify
    bash: printf '%s' "$INPUTS_READY"
    with:
      ignored: value
`,
      'bash-declared.yaml'
    );
    expect(declared.workflow).not.toBeNull();
    expect((declared.warnings ?? []).join('\n')).toContain("'with' is only supported");

    const ignored = parseWorkflow(
      `name: bash-ignored
description: An ignored bash binding cannot provide an input
inputs:
  declared: {}
nodes:
  - id: verify
    bash: printf '%s' "$INPUTS_LOCAL"
    with:
      local: value
`,
      'bash-ignored.yaml'
    );
    expect(ignored.workflow).toBeNull();
    expect(ignored.error?.error).toContain('INPUTS_LOCAL');
    expect(ignored.error?.error).toContain("bash nodes do not support node-local 'with:'");
  });

  test('warns for other static env reads with stable source and available-name details', () => {
    const result = parseWorkflow(
      `name: advisory-read
description: Surface an ambient environment dependency without rejecting it
inputs:
  middle:
    default: value
nodes:
  - id: verify
    script: |
      console.log('start')
      console.log(process.env.PROJECT_TOKEN)
    runtime: bun
    with:
      zeta: true
      alpha: false
`,
      'advisory-read.yaml'
    );

    expect(result.workflow).not.toBeNull();
    const warnings = result.warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('PROJECT_TOKEN');
    expect(warnings[0]).toContain('script line 2');
    expect(warnings[0]).toContain("Available bindings/inputs: 'alpha', 'middle', 'zeta'.");
  });

  test('does not claim dynamic, aliased, or unsupported accessors', () => {
    const result = parseWorkflow(
      `name: unsupported-forms
description: Keep the lexical detection boundary explicit
nodes:
  - id: python
    script: |
      key = "INPUTS_DYNAMIC"
      print(os.environ[key])
      print(os.getenv("INPUTS_GETENV"))
      env = os.environ
      print(env["INPUTS_ALIAS"])
    runtime: uv
  - id: javascript
    script: |
      const key = "INPUTS_DYNAMIC"
      console.log(process.env[key])
      const { INPUTS_DESTRUCTURED } = process.env
      const env = process.env
      console.log(env.INPUTS_ALIAS)
    runtime: bun
  - id: shell
    bash: printf '%s' "$HOME"
`,
      'unsupported-forms.yaml'
    );

    expect(result.workflow).not.toBeNull();
    expect(result.warnings).toEqual([]);
  });

  test('walks loop-group exec bodies once', () => {
    const result = parseWorkflow(
      `name: nested-body
description: Validate an exec node nested in a loop group
inputs:
  declared: {}
nodes:
  - id: iterate
    loop_group:
      until_bash: exit 0
      max_iterations: 1
      nodes:
        - id: nested
          script: console.log(process.env.INPUTS_MISSING)
          runtime: bun
`,
      'nested-body.yaml'
    );

    expect(result.workflow).toBeNull();
    expect(result.error?.error).toContain('loop_group.nodes.0.script');
    expect(result.error?.error.match(/Node 'nested'/g)).toHaveLength(1);
  });

  test('reports the historical named-script env typo before execution', async () => {
    const root = await createProject();
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = join(root, 'home');
    try {
      await writeFile(
        join(root, '.archon', 'workflows', 'historical.yaml'),
        `name: historical
description: Reproduce the live unbound script input
inputs:
  test_repetitions:
    default: 5
nodes:
  - id: verify
    script: verify
    runtime: uv
`
      );
      const scriptPath = join(root, '.archon', 'scripts', 'verify.py');
      await writeFile(
        scriptPath,
        `import os

fix = os.environ["FIX_OUTPUT"]
repetitions = os.environ.get("INPUTS_TEST_REPETITIONS", "5")
print(fix, repetitions)
`
      );

      const result = await discoverWorkflows(root, { loadDefaults: false });

      expect(result.errors).toEqual([]);
      expect(result.workflows).toHaveLength(1);
      const warnings = result.workflows[0]?.parseWarnings ?? [];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('FIX_OUTPUT');
      expect(warnings[0]).toContain(`${scriptPath.replaceAll('\\', '/')} line 3`);
      expect(warnings[0]).toContain('test_repetitions');
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  });

  test('rejects an unbound inline INPUTS_* read at parse time', () => {
    const result = parseWorkflow(
      `name: inline-unbound
description: Reject an unbound inline input
inputs:
  declared: {}
nodes:
  - id: verify
    script: |
      import os
      print(os.environ["INPUTS_MISSING"])
    runtime: uv
`,
      'inline-unbound.yaml'
    );

    expect(result.workflow).toBeNull();
    expect(result.error?.error).toContain('INPUTS_MISSING');
    expect(result.error?.error).toContain('script line 2');
  });

  test('rejects an unbound named INPUTS_* read and accepts its matching binding', async () => {
    const root = await createProject();
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = join(root, 'home');
    try {
      const workflowPath = join(root, '.archon', 'workflows', 'named.yaml');
      const scriptPath = join(root, '.archon', 'scripts', 'verify.ts');
      await writeFile(
        scriptPath,
        `console.log(process.env.INPUTS_FIX)
`
      );
      await writeFile(
        workflowPath,
        `name: named-unbound
description: Reject an unbound input in a discovered script
inputs:
  declared: {}
nodes:
  - id: verify
    script: verify
    runtime: bun
`
      );

      const unbound = await discoverWorkflows(root, { loadDefaults: false });
      expect(unbound.workflows).toEqual([]);
      expect(unbound.errors).toHaveLength(1);
      expect(unbound.errors[0]?.error).toContain('INPUTS_FIX');
      expect(unbound.errors[0]?.error).toContain(`${scriptPath.replaceAll('\\', '/')} line 1`);

      await writeFile(
        workflowPath,
        `name: named-bound
description: Accept a bound input in a discovered script
inputs:
  declared: {}
nodes:
  - id: verify
    script: verify
    runtime: bun
    with:
      fix: ready
`
      );
      const bound = await discoverWorkflows(root, { loadDefaults: false });
      expect(bound.errors).toEqual([]);
      expect(bound.workflows).toHaveLength(1);
      expect(bound.workflows[0]?.parseWarnings ?? []).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  });
});
