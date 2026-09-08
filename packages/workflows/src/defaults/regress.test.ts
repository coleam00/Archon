import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { execFileAsync } from '@archon/git';
import { validateStructuredOutput } from '@archon/providers/structured-output';
import { parseWorkflow } from '../loader';
import { expandWorkflowIncludes } from '../include-expander';
import { resolveWorkflow } from '../graph-plan';
import { dryRunWorkflow, type DryRunStubs } from '../dry-run';
import { dagNodeSchema, type WorkflowDefinition } from '../schemas';
import { validateInlineExecInputs } from '../exec-input-validation';
import cases from '../../../../.archon/workflows/sdlc/regress/fixtures/cases.json';

const root = join(import.meta.dir, '../../../..');
const pack = join(root, '.archon/workflows/sdlc');
const python = process.platform === 'win32' ? 'python' : 'python3';
let checkout: string;
let revision: string;
const scripts = new Map<string, string>();

async function definition(name: string): Promise<WorkflowDefinition> {
  const parsed = parseWorkflow(
    await readFile(join(pack, name, `archon-${name}.yaml`), 'utf8'),
    `archon-${name}.yaml`
  );
  if (parsed.workflow === null) throw new Error(parsed.error.error);
  expect(parsed.warnings).toEqual([]);
  return parsed.workflow;
}

beforeAll(async () => {
  checkout = await mkdtemp(join(tmpdir(), 'archon-regress-'));
  await execFileAsync('git', ['init', checkout]);
  await writeFile(join(checkout, 'app.py'), 'def add(a, b):\n    return a - b\n');
  await writeFile(join(checkout, 'check.py'), 'from app import add\nassert add(2, 3) == 5\n');
  await execFileAsync('git', ['add', 'app.py', 'check.py'], { cwd: checkout });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'negative control',
    ],
    { cwd: checkout }
  );
  revision = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim();
  for (const name of ['identity', 'route', 'report']) {
    scripts.set(name, await readFile(join(pack, `regress/scripts/${name}.py`), 'utf8'));
  }
});

afterAll(async () => {
  if (checkout) await removeTempTree(checkout);
});

async function simulate(
  stubs: DryRunStubs,
  options: {
    revision?: string;
    validationReport?: string | null;
    investigationReport?: string | null;
    afterScript?: string;
  } = {}
) {
  const definitions = await Promise.all(['regress', 'validate', 'investigate'].map(definition));
  const commands = new Map(
    await Promise.all(
      ['validate', 'investigate'].map(
        async name =>
          [name, await readFile(join(pack, name, 'commands', `${name}.md`), 'utf8')] as const
      )
    )
  );
  const expanded = expandWorkflowIncludes(
    new Map(definitions.map(item => [item.name, item])),
    commands
  );
  expect(expanded.errors).toEqual([]);
  const workflow = expanded.workflows.get('archon-regress');
  if (!workflow) throw new Error('regress failed to expand');

  // Stubbed agents cannot write reports. Seed only their declared evidence;
  // execute every production guard/router/reporter and the include DAG itself.
  const reports = {
    'validation.md':
      options.validationReport === undefined
        ? `stub agent validation report: ${JSON.stringify(stubs.validate__validate)}`
        : options.validationReport,
    'investigation.md':
      options.investigationReport === undefined
        ? 'stub: check.py reproduced add(2, 3) != 5; app.py:2 subtracts. Fix addition and rerun check.py.'
        : options.investigationReport,
  };
  const setup = dagNodeSchema.parse({
    id: 'fixture-evidence',
    runtime: 'bun',
    script: `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const reports = ${JSON.stringify(reports)};
    for (const [name, text] of Object.entries(reports)) {
      if (text !== null) writeFileSync(join(process.env.ARTIFACTS_DIR, name), text);
    }
    console.log('stub agent artifacts');
  `,
  });
  const nodes = workflow.nodes.map(node => {
    if (node.kind !== 'exec' || node.runtime !== 'uv') return node;
    const script = scripts.get(node.script);
    if (!script) throw new Error(`Unresolved production script: ${node.script}`);
    return {
      ...node,
      script:
        node.id === 'after' && options.afterScript ? options.afterScript + '\n' + script : script,
      ...(node.id === 'before' ? { depends_on: ['fixture-evidence'] } : {}),
    };
  });
  expect(validateInlineExecInputs({ ...workflow, nodes }).errors).toEqual([]);
  // Read the actual generated sidecar before dry-run cleanup, without changing
  // the report producer's output or introducing a tracker endpoint in the fixture.
  const inspect = dagNodeSchema.parse({
    id: 'fixture-inspect',
    depends_on: ['report'],
    runtime: 'bun',
    script: `
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    const base = process.env.ARTIFACTS_DIR;
    console.log(JSON.stringify({
      result: JSON.parse(readFileSync(join(base, 'regression.json'), 'utf8')),
      discoveries: JSON.parse(readFileSync(join(base, 'discoveries/regress.json'), 'utf8')),
      after: JSON.parse(readFileSync(join(base, 'regression-after.json'), 'utf8'))
    }));
  `,
  });
  return dryRunWorkflow({
    workflow: resolveWorkflow({ ...workflow, nodes: [setup, ...nodes, inspect] }),
    cwd: root,
    execWorkspace: checkout,
    userMessage: 'Fixture: ordinary-check diagnosis; preserve source and tracker state.',
    inputs: { revision: options.revision ?? revision },
    execCode: true,
    stubs,
  });
}

describe('one-shot regression composition with real scripts and stubbed agents', () => {
  for (const fixture of cases) {
    it(fixture.name, async () => {
      const stubs: DryRunStubs = { validate__validate: fixture.validation };
      if (fixture.investigation) stubs.investigate__investigate = fixture.investigation;
      const result = await simulate(stubs);
      expect(result.outcome).toBe('completed');
      expect(result.missingStubs).toEqual([]);
      const output = JSON.parse(result.summary ?? '{}');
      expect(output.result).toMatchObject({
        status: fixture.status,
        reason: fixture.reason,
        revision,
      });
      expect(output.after.head).toBe(revision);
      expect(output.discoveries).toHaveLength(fixture.status === 'regression' ? 1 : 0);
      if (fixture.status === 'regression') {
        expect(output.discoveries[0]).toMatchObject({
          relation: 'adjacent',
          source_node: 'investigate__investigate',
        });
        expect(output.discoveries[0].evidence).toContain(revision);
      }
    });
  }

  describe('repeated evidence', () => {
    const fixture = cases[1];
    const stubs = {
      validate__validate: fixture.validation,
      investigate__investigate: fixture.investigation!,
    };
    let discoveries: unknown;
    beforeAll(async () => {
      const first = await simulate(stubs);
      expect(first.outcome).toBe('completed');
      discoveries = JSON.parse(first.summary ?? '{}').discoveries;
    });
    it('preserves the finding without inventing tracking IDs', async () => {
      const second = await simulate(stubs);
      expect(second.outcome).toBe('completed');
      const repeated = JSON.parse(second.summary ?? '{}').discoveries;
      expect(discoveries).toEqual(repeated);
      expect(Object.keys(repeated[0]).sort()).toEqual([
        'claim',
        'evidence',
        'relation',
        'source_node',
        'title',
      ]);
    });
  });

  for (const requestedRevision of ['HEAD', '0000000000000000000000000000000000000000']) {
    it(`refuses revision ${requestedRevision} before checks`, async () => {
      const result = await simulate({}, { revision: requestedRevision });
      expect(result.outcome).toBe('failed');
      expect(result.trace.find(node => node.nodeId === 'before')?.state).toBe('failed');
      expect(result.missingStubs).toEqual([]);
    });
  }

  it('refuses missing performed-check output without guessing from prose', async () => {
    const result = await simulate({
      validate__validate: { green: true, red_cause: '', summary: 'all green' },
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace.find(node => node.nodeId === 'route')?.state).toBe('failed');
  });

  for (const validationReport of [null, '']) {
    it(`refuses ${validationReport === null ? 'missing' : 'empty'} validation evidence`, async () => {
      const result = await simulate(
        { validate__validate: cases[0].validation },
        { validationReport }
      );
      expect(result.outcome).toBe('failed');
      expect(result.trace.find(node => node.nodeId === 'route')?.state).toBe('failed');
    });
  }

  it('refuses a rooted claim without an investigation report', async () => {
    const result = await simulate(
      {
        validate__validate: cases[1].validation,
        investigate__investigate: cases[1].investigation!,
      },
      { investigationReport: null }
    );
    expect(result.outcome).toBe('failed');
    expect(result.trace.find(node => node.nodeId === 'investigate__assert-intact')?.state).toBe(
      'failed'
    );
  });

  it('refuses missing investigation output and still reaches the final identity guard', async () => {
    const result = await simulate({ validate__validate: cases[1].validation });
    expect(result.outcome).toBe('failed');
    expect(result.missingStubs).toEqual(['investigate__investigate']);
    expect(result.trace.find(node => node.nodeId === 'after')?.state).toBe('completed');
    expect(result.trace.find(node => node.nodeId === 'report')?.state).toBe('failed');
  });

  it('does not infer performed checks from a green English summary', async () => {
    const result = await simulate({
      validate__validate: { ...cases[5].validation, summary: 'All tests passed.' },
    });
    expect(result.outcome).toBe('completed');
    expect(JSON.parse(result.summary ?? '{}').result.reason).toBe('no_checks');
  });

  it('records and refuses a moved HEAD after checks', async () => {
    const result = await simulate(
      { validate__validate: cases[0].validation },
      {
        afterScript:
          'import subprocess\nsubprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "moved"], check=True, capture_output=True)',
      }
    );
    expect(result.outcome).toBe('failed');
    expect(result.trace.find(node => node.nodeId === 'after')?.state).toBe('failed');
    await execFileAsync('git', ['checkout', '--detach', revision], { cwd: checkout });
  });

  it('refuses changed tracked source before spending', async () => {
    await writeFile(join(checkout, 'app.py'), 'def add(a, b):\n    return a + b\n');
    try {
      const result = await simulate({});
      expect(result.outcome).toBe('failed');
      expect(result.trace.find(node => node.nodeId === 'before')?.state).toBe('failed');
      expect(result.missingStubs).toEqual([]);
    } finally {
      await writeFile(join(checkout, 'app.py'), 'def add(a, b):\n    return a - b\n');
    }
  });

  it('uses a real failing ordinary check in a plain repository negative control', async () => {
    const failed = Bun.spawn([python, '-B', 'check.py'], {
      cwd: checkout,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const failure = await new Response(failed.stderr).text();
    expect(await failed.exited).toBe(1);
    expect(failure).toContain('AssertionError');
    const red = await simulate(
      {
        validate__validate: cases[1].validation,
        investigate__investigate: cases[1].investigation!,
      },
      { validationReport: `${python} -B check.py\nexit: 1\n${failure}` }
    );
    expect(red.outcome).toBe('completed');
    expect(JSON.parse(red.summary ?? '{}').result.status).toBe('regression');
  });

  it('reports healthy after correcting the plain repository control', async () => {
    await writeFile(join(checkout, 'app.py'), 'def add(a, b):\n    return a + b\n');
    await execFileAsync('git', ['add', 'app.py'], { cwd: checkout });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'healthy control',
      ],
      { cwd: checkout }
    );
    revision = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim();
    const passed = Bun.spawn([python, '-B', 'check.py'], {
      cwd: checkout,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await passed.exited).toBe(0);
    const green = await simulate(
      { validate__validate: cases[0].validation },
      { validationReport: `${python} -B check.py\nexit: 0` }
    );
    expect(green.outcome).toBe('completed');
    expect(JSON.parse(green.summary ?? '{}').result.status).toBe('healthy');
  });
});

it('validate fixtures carry the performed-check fact from the producer schema', async () => {
  const producer = (await definition('validate')).nodes.find(node => node.id === 'validate');
  if (producer?.kind !== 'agent' || !producer.output_format) {
    throw new Error('validate schema missing');
  }
  for (const name of await readdir(join(pack, 'validate/fixtures'))) {
    const fixture = Bun.YAML.parse(
      await readFile(join(pack, 'validate/fixtures', name), 'utf8')
    ) as { validate: unknown };
    expect(validateStructuredOutput(fixture.validate, producer.output_format).valid).toBe(true);
  }
  for (const fixture of cases) {
    expect(validateStructuredOutput(fixture.validation, producer.output_format).valid).toBe(true);
  }
  const properties = producer.output_format.properties as Record<string, Record<string, unknown>>;
  for (const consumer of ['deliver', 'ship', 'upkeep']) {
    for (const name of await readdir(join(pack, consumer, 'fixtures'))) {
      if (!name.endsWith('.stubs.yaml')) continue;
      const stubs = Bun.YAML.parse(
        await readFile(join(pack, consumer, 'fixtures', name), 'utf8')
      ) as Record<string, Record<string, unknown>>;
      for (const [node, stub] of Object.entries(stubs)) {
        if (!node.endsWith('validate__validate')) continue;
        // Some existing negative fixtures intentionally omit other producer fields.
        // This additive fact still conforms to its owning schema on every consumer.
        expect(
          validateStructuredOutput(stub.checks_performed, properties.checks_performed).valid
        ).toBe(true);
      }
    }
  }
  expect(
    validateStructuredOutput(
      { green: true, red_cause: '', summary: 'green' },
      producer.output_format
    ).valid
  ).toBe(false);
});
