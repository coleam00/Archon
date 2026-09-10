import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_WORKFLOWS } from './bundled-defaults';
import { parseWorkflow } from '../loader';

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
  const include = (
    JSON.parse(readFileSync(PACK_TSCONFIG, 'utf-8')) as { include: string[] }
  ).include;
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

describe('the red-cause vocabulary has one owner', () => {
  /** The vocabulary as the pack's own module exports it, read by executing it. */
  function declaredVocabulary(): string[] {
    const run = Bun.spawnSync(
      [
        'bun',
        '--no-env-file',
        '-e',
        `import { RED_CAUSES } from ${JSON.stringify(SHARED_VERDICT)};` +
          'console.log(JSON.stringify(RED_CAUSES));',
      ],
      { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' }
    );
    if (run.exitCode !== 0) {
      throw new Error(`could not read the shared vocabulary: ${run.stderr.toString().trim()}`);
    }
    return JSON.parse(run.stdout.toString()) as string[];
  }

  function redCauseEnum(workflow: string, nodeId: string): unknown {
    const parsed = parseWorkflow(BUNDLED_WORKFLOWS[workflow] ?? '', `${workflow}.yaml`);
    if (parsed.workflow === null) throw new Error(parsed.error.error);
    const node = parsed.workflow.nodes.find(candidate => candidate.id === nodeId);
    const properties = (node?.output_format as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    return (properties?.red_cause as { enum?: unknown } | undefined)?.enum;
  }

  // Every script that routes on a red cause imports it from `.shared/verdict.ts`, so
  // changing the list there changes every consumer without another edit. Two
  // declarations cannot import: implement's and validate's `red_cause` schemas are
  // JSON Schema inside YAML, and they are the only thing that constrains what an
  // agent may declare. This is what keeps them from drifting away from the module —
  // a cause one side accepts and the other refuses would strand an iteration
  // between them. The empty string rides along in the schemas because OpenAI strict
  // mode rejects a schema whose `required` omits a declared property.
  it.each([
    ['archon-implement', 'implement'],
    ['archon-validate', 'validate'],
  ])('%s declares exactly the shared vocabulary', (workflow, nodeId) => {
    expect(redCauseEnum(workflow, nodeId)).toEqual([...declaredVocabulary(), '']);
  });
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
    const schema = node?.output_format as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;

    expect(schema?.required).toContain('report');
    expect(schema?.properties?.report).toEqual({
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['archon_artifact'] },
        run_id: { type: 'string' },
        path: { type: 'string', enum: [reportFile] },
      },
      required: ['type', 'run_id', 'path'],
    });
  });

  it('no pack workflow still guards its report with an assert-intact node', () => {
    for (const [name, source] of Object.entries(BUNDLED_WORKFLOWS)) {
      if (!name.startsWith('archon-')) continue;
      expect({ name, guards: source.includes('id: assert-intact') }).toEqual({
        name,
        guards: false,
      });
    }
  });
});
