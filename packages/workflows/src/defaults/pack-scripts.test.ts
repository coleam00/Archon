import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_WORKFLOWS } from './bundled-defaults';
import { parseWorkflow } from '../loader';

type ParsedNode = NonNullable<ReturnType<typeof parseWorkflow>['workflow']>['nodes'][number];

/** The declared schema of a node kind that can carry one. `include:` cannot. */
function outputFormat(node: ParsedNode | undefined): Record<string, unknown> | undefined {
  if (node === undefined || !('output_format' in node)) return undefined;
  return node.output_format;
}

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const PACKS_ROOT = join(REPO_ROOT, '.archon', 'workflows');
const PACK_TSCONFIG = join(PACKS_ROOT, 'tsconfig.json');
const SHARED_VERDICT = join(PACKS_ROOT, 'sdlc', '.shared', 'verdict.ts');

function trackedPackScripts(): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--', '.archon/workflows'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (listed.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.toString().trim()}`);
  }
  return listed.stdout
    .toString()
    .split('\0')
    .filter(path => path.endsWith('.ts'))
    .map(path => path.slice('.archon/workflows/'.length))
    .sort();
}

function includedByOwningProject(): string[] {
  const include = (JSON.parse(readFileSync(PACK_TSCONFIG, 'utf-8')) as { include: string[] })
    .include;
  const matched = new Set<string>();
  for (const pattern of include) {
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: PACKS_ROOT, dot: true })) {
      matched.add(path.split('\\').join('/'));
    }
  }
  return [...matched].sort();
}

describe('workflow pack scripts are validated where they live', () => {
  it('selects the same script family for type-check, lint and execution', () => {
    // `.archon/workflows/tsconfig.json` is the owning configuration: `bun run
    // type-check` compiles that project, and eslint.config.mjs and scripts/lint.ts
    // both derive their globs from its `include` rather than restating them. What
    // no config can notice on its own is a pack script placed somewhere the globs
    // do not reach — it would simply go unchecked, with nothing failing. This is
    // that check.
    expect(includedByOwningProject()).toEqual(trackedPackScripts());
  });

  it('has scripts to validate at all', () => {
    // Guards the check above against passing by matching nothing against nothing.
    expect(trackedPackScripts().length).toBeGreaterThan(0);
  });
});

describe('every routed vocabulary has one owner', () => {
  /** A vocabulary as the pack's own module exports it, read by executing the module. */
  function exportedVocabulary(name: string): string[] {
    const run = Bun.spawnSync(
      [
        'bun',
        '--no-env-file',
        '-e',
        `import { ${name} } from ${JSON.stringify(SHARED_VERDICT)};` +
          `console.log(JSON.stringify(${name}));`,
      ],
      { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' }
    );
    if (run.exitCode !== 0) {
      throw new Error(`could not read ${name}: ${run.stderr.toString().trim()}`);
    }
    return JSON.parse(run.stdout.toString()) as string[];
  }

  function declaredEnum(workflow: string, nodeId: string, field: string): unknown {
    const parsed = parseWorkflow(BUNDLED_WORKFLOWS[workflow] ?? '', `${workflow}.yaml`);
    if (parsed.workflow === null) throw new Error(parsed.error.error);
    const node = parsed.workflow.nodes.find(candidate => candidate.id === nodeId);
    const properties = (outputFormat(node) as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    return (properties?.[field] as { enum?: unknown } | undefined)?.enum;
  }

  // Every script that routes on one of these imports it from `.shared/verdict.ts`, so
  // changing the list there changes every consumer without another edit. The schemas
  // below cannot import: they are JSON Schema inside YAML, and they are the only thing
  // constraining what an agent may declare. This is what keeps them from drifting away
  // from the module — a value one side accepts and the other refuses would strand an
  // iteration between them. `red_cause` carries the empty string as its absent form,
  // because OpenAI strict mode rejects a schema whose `required` omits a declared
  // property; the enum is otherwise exactly the module's.
  it.each([
    ['archon-implement', 'implement', 'red_cause', 'RED_CAUSES', ['']],
    ['archon-validate', 'validate', 'red_cause', 'RED_CAUSES', ['']],
    ['archon-review', 'synthesize', 'action', 'REVIEW_ACTIONS', []],
  ] as const)(
    '%s declares exactly the shared vocabulary for %s.%s',
    (workflow, nodeId, field, exportName, extra) => {
      expect(declaredEnum(workflow, nodeId, field)).toEqual([
        ...exportedVocabulary(exportName),
        ...extra,
      ]);
    }
  );
});

describe('advisory verdicts carry the report that backs them', () => {
  // Each advisory node returns a pointer at the report it wrote, and the engine
  // refuses a pointer at a file this run does not have before the node completes.
  // Four near-identical `test -s` nodes used to check that one hop later; the check
  // is the producer's now, which is why the shape below is worth pinning here —
  // a fixture stubs these nodes, so no fixture can exercise it.
  it.each([
    ['archon-triage', 'triage', 'triage.md'],
    ['archon-plan', 'plan', 'plan.md'],
    ['archon-investigate', 'investigate', 'investigation.md'],
    ['archon-upkeep', 'assess', 'upkeep-assessment.md'],
  ])('%s returns a validated pointer at %s', (workflow, nodeId, reportFile) => {
    const parsed = parseWorkflow(BUNDLED_WORKFLOWS[workflow] ?? '', `${workflow}.yaml`);
    if (parsed.workflow === null) throw new Error(parsed.error.error);
    const node = parsed.workflow.nodes.find(candidate => candidate.id === nodeId);
    const schema = outputFormat(node) as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;

    // The three properties the engine's validator keys on, not the object's identity:
    // adding a constraint such as `minLength` to `run_id` is a tightening, not a
    // regression, and should not fail here.
    const pointer = schema?.properties?.report as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    expect(schema?.required).toContain('report');
    expect(pointer?.required).toEqual(['type', 'run_id', 'path']);
    expect(pointer?.properties?.type).toMatchObject({ enum: ['archon_artifact'] });
    expect(pointer?.properties?.path).toMatchObject({ enum: [reportFile] });
  });
});
