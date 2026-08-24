/**
 * Declared-data dry-run fixtures (#2772).
 *
 * A fixture is a `<name>.stubs.yaml` file in a `fixtures/` directory next to a
 * workflow YAML. Reserved top-level keys carry the invocation requirements and
 * the expected outcome, so a fixture runner needs no prose conventions:
 *
 *   fixture:
 *     expect: completed          # or `failed`
 *     fail-node: gate-ready      # required iff expect: failed
 *     inputs:                    # caller-supplied declared-input values
 *       branch: "task-123"
 *   exec-code: false             # execute script/bash nodes instead of stubbing
 *
 * Every remaining key is a node-id → stub-output entry, exactly what
 * `workflow run --dry-run --stubs` accepts. The only execution path is
 * `dryRunWorkflow`, so a fixture can never trigger a real run or provider call.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from '@hono/zod-openapi';
import { createLogger } from '@archon/paths';
import { dryRunStubsSchema, dryRunWorkflow, type DryRunResult, type DryRunStubs } from './dry-run';
import type { WorkflowWithSource } from './schemas/workflow';
import type { WorkflowConfig } from './deps';
import type { ResolvedAiProfile } from './model-validation';
import { liveSourceRoots } from './workflow-source';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  cachedLog ??= createLogger('workflow.fixture-runner');
  return cachedLog;
}

export const fixtureDeclarationSchema = z
  .object({
    expect: z.enum(['completed', 'failed']).default('completed'),
    'fail-node': z.string().optional(),
    inputs: z.record(z.string(), z.string()).optional(),
  })
  .refine(decl => decl.expect !== 'failed' || decl['fail-node'] !== undefined, {
    message: "fail-node is required when expect is 'failed'",
  });
export type FixtureDeclaration = z.infer<typeof fixtureDeclarationSchema>;

const RESERVED_FIXTURE_KEYS = new Set(['fixture', 'exec-code']);

export interface ParsedFixtureFile {
  declaration: FixtureDeclaration;
  execCode: boolean;
  stubs: DryRunStubs;
}

/** Split reserved metadata keys from node stubs; invalid metadata is a hard error, never silently stripped — a real node id could collide with a reserved key. */
export function parseFixtureFile(text: string, path: string): ParsedFixtureFile {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse fixture '${path}': ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid fixture '${path}': expected one YAML mapping`);
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  const rest: [string, unknown][] = [];
  let declaration: FixtureDeclaration = { expect: 'completed' };
  let execCode = false;
  for (const [key, value] of entries) {
    if (!RESERVED_FIXTURE_KEYS.has(key)) {
      rest.push([key, value]);
      continue;
    }
    if (key === 'exec-code') {
      if (typeof value !== 'boolean') {
        throw new Error(`Invalid fixture '${path}': 'exec-code' must be true or false`);
      }
      execCode = value;
      continue;
    }
    const result = fixtureDeclarationSchema.safeParse(value ?? {});
    if (!result.success) {
      const issues = result.error.issues.map(issue => issue.message).join('; ');
      throw new Error(`Invalid fixture '${path}': 'fixture' block — ${issues}`);
    }
    declaration = result.data;
  }

  const stubsResult = dryRunStubsSchema.safeParse(Object.fromEntries(rest));
  if (!stubsResult.success) {
    const issues = stubsResult.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid fixture '${path}': ${issues}`);
  }
  return { declaration, execCode, stubs: stubsResult.data };
}

const FIXTURES_DIR = 'fixtures';
const FIXTURE_SUFFIX = '.stubs.yaml';
// Discovery walks user directories; the bound mirrors discovery's own depth cap so a
// pathological tree cannot hang the command.
const MAX_WALK_DEPTH = 12;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface DiscoveredFixture {
  /** Label relative to its discovery scope root, e.g. `sdlc/deliver/fixtures/clean.stubs.yaml`. */
  readonly label: string;
  /** First path segment under the scope root — the pack, when fixtures are organized in packs. */
  readonly pack: string | undefined;
  readonly path: string;
  readonly workflowNames: readonly string[];
}

/** Collect every `*.yaml` sibling of a `fixtures/` dir and read its declared workflow names. */
async function workflowNamesBeside(fixturesDir: string): Promise<string[]> {
  const parent = join(fixturesDir, '..');
  const names: string[] = [];
  for (const entry of await readdir(parent)) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    try {
      const doc = Bun.YAML.parse(await Bun.file(join(parent, entry)).text());
      if (
        doc !== null &&
        typeof doc === 'object' &&
        typeof (doc as { name?: unknown }).name === 'string'
      ) {
        names.push((doc as { name: string }).name);
      }
    } catch (error) {
      getLog().debug(
        { file: entry, error: (error as Error).message },
        'fixture_runner.sibling_workflow_read_failed'
      );
    }
  }
  return [...new Set(names)];
}

async function walkForFixtures(
  root: string,
  depth: number,
  out: DiscoveredFixture[]
): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(root, entry.name);
    if (entry.name === FIXTURES_DIR) {
      const labelRoot = join(root, '..');
      for (const file of await readdir(dirPath)) {
        if (!file.endsWith(FIXTURE_SUFFIX)) continue;
        const rel = relative(labelRoot, join(dirPath, file));
        out.push({
          label: rel.split(sep).join('/'),
          pack: rel.split(sep).length > 1 ? rel.split(sep)[0] : undefined,
          path: join(dirPath, file),
          workflowNames: await workflowNamesBeside(dirPath),
        });
      }
      continue;
    }
    await walkForFixtures(dirPath, depth + 1, out);
  }
}

async function discoverFixtures(roots: readonly string[]): Promise<DiscoveredFixture[]> {
  const seen = new Set<string>();
  const found: DiscoveredFixture[] = [];
  for (const root of roots) {
    if (!(await exists(root))) continue;
    const before = found.length;
    await walkForFixtures(root, 0, found);
    for (let i = before; i < found.length; i++) {
      if (seen.has(found[i].label)) {
        // Higher-precedence scope already discovered this fixture path.
        found.splice(i, 1);
        i--;
      } else {
        seen.add(found[i].label);
      }
    }
  }
  return found;
}

export interface FixtureCheckResult {
  readonly fixture: string;
  readonly workflow: string;
  readonly expect: 'completed' | 'failed';
  readonly outcome?: DryRunResult['outcome'];
  readonly pass: boolean;
  readonly failureReason?: string;
  readonly missingStubs: readonly string[];
  readonly unusedStubs: readonly string[];
}

export interface FixtureReport {
  readonly results: readonly FixtureCheckResult[];
  readonly passed: number;
  readonly failed: number;
}

export interface RunFixturesOptions {
  workflows: readonly WorkflowWithSource[];
  cwd: string;
  config?: WorkflowConfig;
  aiProfile?: ResolvedAiProfile;
  /** Restrict to one workflow name or pack prefix; unresolved values are an error. */
  target?: string;
}

/**
 * Run every discovered fixture through `dryRunWorkflow` and judge each against its
 * declaration. A fixture passes iff the outcome matches, a declared failure fails on
 * exactly the declared node, and no reached node lacked a stub. Unused stubs are a
 * warning, not a failure — stubs for conditionally-skipped branches are legitimate.
 */
export async function runFixtures(options: RunFixturesOptions): Promise<FixtureReport> {
  const roots = liveSourceRoots(options.cwd);
  // Same scope roots discovery reads, project root included as its `.archon/workflows` dir.
  const all = await discoverFixtures([
    ...(roots.project !== null ? [join(roots.project, '.archon', 'workflows')] : []),
    roots.globalWorkflows,
    roots.bundledWorkflows,
  ]);

  const byName = new Map(options.workflows.map(ws => [ws.workflow.name, ws]));
  let selected = all;
  if (options.target !== undefined) {
    const targetName = options.target;
    if (byName.has(targetName)) {
      selected = all.filter(fixture => fixture.workflowNames.includes(targetName));
    } else {
      selected = all.filter(fixture => fixture.pack === options.target);
    }
    if (selected.length === 0) {
      const names = [...byName.keys()].sort().join(', ');
      throw new Error(
        `No fixtures found for '${targetName}'. Name a workflow with fixtures (${names}) or a pack directory containing them.`
      );
    }
  }

  const results: FixtureCheckResult[] = [];
  for (const fixture of selected) {
    results.push(...(await runOneFixture(fixture, byName, options)));
  }

  return Object.freeze({
    results,
    passed: results.filter(r => r.pass).length,
    failed: results.filter(r => !r.pass).length,
  });
}

async function runOneFixture(
  fixture: DiscoveredFixture,
  byName: Map<string, WorkflowWithSource>,
  options: RunFixturesOptions
): Promise<FixtureCheckResult[]> {
  let parsed: ParsedFixtureFile;
  try {
    parsed = parseFixtureFile(await Bun.file(fixture.path).text(), fixture.path);
  } catch (error) {
    return [
      {
        fixture: fixture.label,
        workflow: fixture.workflowNames[0] ?? '(unresolved)',
        expect: 'completed',
        pass: false,
        failureReason: (error as Error).message,
        missingStubs: [],
        unusedStubs: [],
      },
    ];
  }

  const targets = fixture.workflowNames.filter(name => byName.has(name)).map(name => ({ name }));
  if (targets.length === 0) {
    return [
      {
        fixture: fixture.label,
        workflow: fixture.workflowNames[0] ?? '(none)',
        expect: parsed.declaration.expect,
        pass: false,
        failureReason: `no discovered workflow matches (${fixture.workflowNames.join(', ') || 'none declared alongside'})`,
        missingStubs: [],
        unusedStubs: [],
      },
    ];
  }

  const out: FixtureCheckResult[] = [];
  for (const entry of targets) {
    const ws = byName.get(entry.name);
    if (ws === undefined) continue;
    out.push(await checkFixture(entry.name, ws, fixture, parsed, options));
  }
  return out;
}

async function checkFixture(
  workflowName: string,
  ws: WorkflowWithSource,
  fixture: DiscoveredFixture,
  parsed: ParsedFixtureFile,
  options: RunFixturesOptions
): Promise<FixtureCheckResult> {
  const base = {
    fixture: fixture.label,
    workflow: workflowName,
    expect: parsed.declaration.expect,
  };
  try {
    const result = await dryRunWorkflow({
      workflow: ws.workflow,
      userMessage: '',
      cwd: options.cwd,
      stubs: parsed.stubs,
      ...(parsed.declaration.inputs ? { inputs: parsed.declaration.inputs } : {}),
      execCode: parsed.execCode,
      ...(options.config ? { config: options.config } : {}),
      ...(options.aiProfile ? { aiProfile: options.aiProfile } : {}),
    });

    let failureReason: string | undefined;
    if (result.outcome !== parsed.declaration.expect) {
      failureReason = `expected ${parsed.declaration.expect}, dry-run reported ${result.outcome}`;
    } else if (parsed.declaration.expect === 'failed') {
      const failures = result.trace.filter(entry => entry.state === 'failed');
      if (failures.length !== 1 || failures[0].nodeId !== parsed.declaration['fail-node']) {
        failureReason =
          `expected exactly one failed trace entry on '${parsed.declaration['fail-node']}', got ` +
          failures.map(f => f.nodeId).join(', ');
      }
    } else if (result.missingStubs.length > 0) {
      failureReason = `reached nodes without stubs: ${result.missingStubs.join(', ')}`;
    }

    return {
      ...base,
      outcome: result.outcome,
      pass: failureReason === undefined,
      ...(failureReason !== undefined ? { failureReason } : {}),
      missingStubs: result.missingStubs,
      unusedStubs: result.unusedStubs,
    };
  } catch (error) {
    return {
      ...base,
      pass: false,
      failureReason: (error as Error).message,
      missingStubs: [],
      unusedStubs: [],
    };
  }
}

export function formatFixtureReport(report: FixtureReport): string {
  if (report.results.length === 0) return 'No dry-run fixtures found.';
  const lines: string[] = [];
  for (const r of report.results) {
    const mark = r.pass ? '✔' : '✘';
    const outcome = r.outcome ? ` (${r.outcome})` : '';
    lines.push(`${mark} ${r.fixture} → ${r.workflow}${outcome}`);
    if (r.failureReason) lines.push(`    ${r.failureReason}`);
    if (r.unusedStubs.length > 0) {
      lines.push(`    warning: unused stubs — ${r.unusedStubs.join(', ')}`);
    }
  }
  lines.push('', `${String(report.passed)} passed, ${String(report.failed)} failed`);
  return lines.join('\n');
}
