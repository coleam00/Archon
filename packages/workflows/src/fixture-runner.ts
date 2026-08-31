/**
 * Declared-data dry-run fixtures (#2772).
 *
 * A fixture is a `<name>.stubs.yaml` file in a `fixtures/` directory next to a
 * workflow YAML. Reserved top-level keys carry the invocation requirements and
 * the expected outcome, so a fixture runner needs no prose conventions:
 *
 *   fixture:
 *     expect: completed          # or failed / paused / cancelled
 *     fail-node: gate-ready      # required iff expect: failed; a list names the
 *                                # exact failed set (a loop body failure is two
 *                                # entries: the node and its group)
 *     reached: [review__docs]    # nodes that must complete or be stubbed, under any expect
 *     inputs:                    # caller-supplied declared-input values
 *       branch: "task-123"
 *     resolved-text-contains:    # fragments that must appear in a reached node's resolved text
 *       implement: "task-123"
 *   exec-code: false             # execute script/bash nodes instead of stubbing
 *
 * Every remaining key is a node-id → stub-output entry, exactly what
 * `workflow run --dry-run --stubs` accepts. The only execution path is
 * `dryRunWorkflow`, so a fixture can never trigger a real run or provider call.
 *
 * A fixture run reproduces both halves of a real run's source/target split (#2851).
 * SOURCE — named scripts and command files — resolves through one frozen
 * {@link captureWorkflowSource} taken per invocation, the same mechanism `workflow run`
 * uses, so a fixture cannot pass on a workflow whose capture would break the real run.
 * The TARGET that `exec-code: true` nodes execute against is a scratch worktree of the
 * caller repo's HEAD (see {@link withExecWorkspace}), never the operator's tree.
 */
import { readdir, realpath, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from '@hono/zod-openapi';
import { createLogger, getArchonTempPath } from '@archon/paths';
import { execFileAsync } from '@archon/git';
import {
  RESERVED_FIXTURE_KEYS,
  dryRunStubsSchema,
  dryRunWorkflow,
  type DryRunResult,
  type DryRunStubs,
} from './dry-run';
import type { WorkflowWithSource } from './schemas/workflow';
import type { WorkflowConfig } from './deps';
import type { ResolvedAiProfile } from './model-validation';
import { resolveTopLevelInputs } from './utils/workflow-requirements';
import {
  captureWorkflowSource,
  capturedSourceRoots,
  liveSourceRoots,
  type WorkflowSourceConfig,
  type WorkflowSourceRoots,
} from './workflow-source';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  cachedLog ??= createLogger('workflow.fixture-runner');
  return cachedLog;
}

export const fixtureDeclarationSchema = z
  .object({
    expect: z.enum(['completed', 'failed', 'paused', 'cancelled']).default('completed'),
    // A single node id, or the exact set of failed entries when one failure
    // implies another — a node failing inside a loop_group fails the group
    // too, so that shape is always two entries and was inexpressible before.
    'fail-node': z.union([z.string(), z.array(z.string()).nonempty()]).optional(),
    reached: z.array(z.string()).optional(),
    inputs: z.record(z.string(), z.string()).optional(),
    'resolved-text-contains': z.record(z.string(), z.string()).optional(),
  })
  .refine(decl => decl.expect !== 'failed' || decl['fail-node'] !== undefined, {
    message: "fail-node is required when expect is 'failed'",
  });
export type FixtureDeclaration = z.infer<typeof fixtureDeclarationSchema>;

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
// Discovery walks user directories. This is a hang-guard margin for a pathological
// tree, not a mirror of discovery's cap (MAX_DISCOVERY_DEPTH is 1, and the catalog
// reaches one packaged-scanner level deeper): fixtures below the catalog's reach are
// discovered here but can never match a loadable workflow.
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
  /** Display path relative to its discovery scope root, e.g. `sdlc/deliver/fixtures/clean.stubs.yaml`. */
  readonly label: string;
  /** Directory segments between the scope root and `fixtures/`, e.g. `['sdlc', 'deliver']`. */
  readonly dirs: readonly string[];
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
  scopeRoot: string,
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
      const dirs = relative(scopeRoot, root)
        .split(sep)
        .filter(segment => segment.length > 0);
      for (const file of await readdir(dirPath)) {
        if (!file.endsWith(FIXTURE_SUFFIX)) continue;
        out.push({
          label: [...dirs, FIXTURES_DIR, file].join('/'),
          dirs,
          path: join(dirPath, file),
          workflowNames: await workflowNamesBeside(dirPath),
        });
      }
      continue;
    }
    await walkForFixtures(scopeRoot, dirPath, depth + 1, out);
  }
}

async function discoverFixtures(roots: readonly string[]): Promise<DiscoveredFixture[]> {
  const seen = new Set<string>();
  const found: DiscoveredFixture[] = [];
  for (const root of roots) {
    if (!(await exists(root))) continue;
    // Path targets compare against fixture paths by real path, so discovery reports
    // canonical spellings and a target spelled through a symlink still matches
    // (e.g. macOS /tmp → /private/tmp).
    const scopeRoot = await realpath(root).catch(() => root);
    const before = found.length;
    await walkForFixtures(scopeRoot, scopeRoot, 0, found);
    for (let i = before; i < found.length; i++) {
      // Keyed on the scope-relative label, not the absolute path: an absolute path is
      // unique per scope by construction, so keying on it would never dedup anything and
      // a project copy of a bundled workflow would run both fixtures. The label is what
      // makes an override shadow the copy it overrides, matching how `workflow-discovery`
      // resolves the same scope chain for the workflow files themselves.
      if (seen.has(found[i].label)) {
        // Higher-precedence scope already discovered this fixture.
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
  readonly expect: DryRunResult['outcome'];
  readonly outcome?: DryRunResult['outcome'];
  readonly pass: boolean;
  readonly failureReason?: string;
  readonly missingStubs: readonly string[];
  /**
   * The subset of `missingStubs` a `trigger_rule: all_done` join tolerated (#2869).
   * Carried through from the dry run so a reader can tell a gap that never blocked
   * this fixture from one that would have — `missingStubs` alone cannot, and a
   * tolerated gap appears there on a PASSING fixture.
   */
  readonly toleratedMissingStubs: readonly string[];
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
  /** Directory from which a relative fixture path target is interpreted; defaults to `cwd`. */
  targetCwd?: string;
  /** Source scopes corresponding to `workflows`; defaults to the live project, global, and bundled scopes. */
  sourceRoots?: WorkflowSourceRoots;
  /**
   * The install's command and default-loading policy, frozen with the capture so a repo
   * that points `commands.folder` outside `.archon/commands` still resolves its commands.
   *
   * Required, with no default — the same closed seam {@link capturedSourceRoots} enforces
   * one call deeper, for the same reason. A default here would let a caller that never
   * read the repo's config freeze a narrower set of directories than the real run takes,
   * which is exactly the divergence `workflowSourceConfigFrom` exists to prevent. A caller
   * that genuinely wants the standard folders passes `DEFAULT_WORKFLOW_SOURCE_CONFIG` and
   * says so.
   */
  sourceConfig: WorkflowSourceConfig;
  config?: WorkflowConfig;
  aiProfile?: ResolvedAiProfile;
  /**
   * Restrict to a workflow name, a pack or workflow-folder name, or a path (relative
   * or absolute) to any fixture-containing directory. Relative paths resolve from
   * `targetCwd`, then fall back to `cwd` when absent — a directory above a `fixtures/`
   * dir, the `fixtures/` dir itself, or an ancestor of one. Unresolved values error.
   */
  target?: string;
}

function isCallerRelativePathTarget(target: string): boolean {
  return (
    !isAbsolute(target) &&
    (target === '.' ||
      target === '..' ||
      target.startsWith('./') ||
      target.startsWith('../') ||
      target.startsWith('.\\') ||
      target.startsWith('..\\') ||
      target.includes('/') ||
      target.includes('\\'))
  );
}

/**
 * Run `fn` against ONE frozen capture of the caller's executable source (#2851).
 *
 * A real run freezes its source before it executes a node, and every later lookup goes
 * to the capture. Fixtures do the same, for the same two reasons: a `__file__`-relative
 * script resolved live can read and write the operator's checkout no matter where the
 * node executes, and a workflow that only breaks once captured — the failure class
 * `workflow-source.ts` documents — has to be reachable from `workflow test` or the
 * command cannot certify what it claims to.
 *
 * One capture per invocation, not per fixture: the capture copies live files, so taking
 * it once is also what makes the whole run a function of a single snapshot. Uncommitted
 * authoring is unaffected — the copy is of the working tree, not of HEAD.
 */
async function withCapturedFixtureSource<T>(
  cwd: string,
  sourceConfig: WorkflowSourceConfig,
  fn: (roots: WorkflowSourceRoots) => Promise<T>
): Promise<T> {
  const captureRoot = join(getArchonTempPath(), `fixture-source-${randomUUID()}`);
  let capture;
  try {
    capture = await captureWorkflowSource({
      sourceRoot: cwd,
      captureRoot,
      ...(sourceConfig.command_folder !== undefined
        ? { commandFolder: sourceConfig.command_folder }
        : {}),
      sourceConfig,
    });
  } catch (error) {
    throw new Error(
      `Fixtures could not freeze the workflow source in '${cwd}': ${(error as Error).message}`
    );
  }
  try {
    return await fn(capturedSourceRoots(capture.captureRoot, capture.manifest.source_config));
  } finally {
    await rm(captureRoot, { recursive: true, force: true }).catch((error: unknown) => {
      getLog().warn(
        { captureRoot, error: error instanceof Error ? error.message : String(error) },
        'fixture_runner.source_capture_dispose_failed'
      );
    });
  }
}

/**
 * Run `fn` with an isolated execution workspace for an exec-code fixture (#2851).
 *
 * The workspace is a detached scratch worktree of the caller repo's HEAD, so executed
 * nodes see a clean checkout: pre-existing diffs and untracked files in the caller's
 * tree cannot leak into a fixture verdict, and anything executed code writes lands in
 * the scratch tree instead of the caller's checkout. A caller outside any git
 * repository is a hard failure — the only alternative would be executing in place,
 * which is exactly the dependency on tree state this prevents.
 */
async function withExecWorkspace<T>(
  cwd: string,
  fn: (workspace: string) => Promise<T>
): Promise<T> {
  try {
    await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
  } catch {
    throw new Error(
      `Exec-code fixtures require a git checkout to isolate execution; '${cwd}' is not inside a git repository`
    );
  }
  // git worktree add creates the workspace path's leading directories itself.
  const workspace = join(getArchonTempPath(), `fixture-exec-${randomUUID()}`);
  try {
    await execFileAsync('git', ['worktree', 'add', '--detach', workspace, 'HEAD'], { cwd });
  } catch (error) {
    throw new Error(
      `Exec-code fixture could not create an isolated execution workspace from HEAD: ${(error as Error).message}`
    );
  }
  try {
    return await fn(workspace);
  } finally {
    await disposeExecWorkspace(cwd, workspace);
  }
}

/**
 * Disposal runs in `withExecWorkspace`'s `finally`, so nothing here may throw: an escaping
 * error would REPLACE the value `fn` already produced, and `checkFixture` would report a
 * cleanup message as the fixture's verdict. That is the same "a verdict depends on
 * incidental environment state" bug this module exists to remove, just relocated to the
 * exit path. Both failures are logged and the debris is left behind instead.
 */
async function disposeExecWorkspace(cwd: string, workspace: string): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', workspace], { cwd });
    return;
  } catch (error) {
    getLog().warn(
      { workspace, error: error instanceof Error ? error.message : String(error) },
      'fixture_runner.exec_workspace_dispose_failed'
    );
  }
  // The tree itself is disposable; rm covers the case where git cannot remove it (e.g. the
  // caller repo moved) and would otherwise leave it behind. `force: true` only suppresses
  // ENOENT — a permission error or a still-held handle still rejects.
  await rm(workspace, { recursive: true, force: true }).catch((error: unknown) => {
    getLog().warn(
      { workspace, error: error instanceof Error ? error.message : String(error) },
      'fixture_runner.exec_workspace_remove_failed'
    );
  });
}

/**
 * Run every discovered fixture through `dryRunWorkflow` and judge each against its
 * declaration. A fixture passes iff the outcome matches, a declared failure fails on
 * exactly the declared node, every declared reached node completes or is stubbed, and
 * no reached node lacked a stub. Unused stubs are a warning, not a failure — stubs for
 * conditionally-skipped branches are legitimate.
 */
export async function runFixtures(options: RunFixturesOptions): Promise<FixtureReport> {
  const roots = options.sourceRoots ?? liveSourceRoots(options.cwd);
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
    // A target resolves when it names a discovered workflow, a directory above a
    // fixtures dir (pack name or workflow folder), or a path containing fixtures.
    const targetFromInvocation = resolve(options.targetCwd ?? options.cwd, targetName);
    const targetDir =
      isCallerRelativePathTarget(targetName) && (await exists(targetFromInvocation))
        ? targetFromInvocation
        : resolve(options.cwd, targetName);
    // Discovery reports fixture paths as real paths, so canonicalize the target
    // before the containment check; a nonexistent target can never contain a
    // fixture, so keeping its resolved spelling there is safe.
    const targetReal = await realpath(targetDir).catch(() => targetDir);
    // Name matching is gated on catalog membership: a workflow file can sit on disk with
    // a `fixtures/` dir beside it and still never load. Without the gate its name would
    // select fixtures the run cannot check, turning an unresolved target into a per-fixture
    // "no discovered workflow matches" failure instead of the documented exit-1 error. The
    // suggestion list below applies the same gate.
    const targetIsLoadedWorkflow = byName.has(targetName);
    selected = all.filter(
      fixture =>
        (targetIsLoadedWorkflow && fixture.workflowNames.includes(targetName)) ||
        fixture.dirs.includes(targetName) ||
        fixture.path.startsWith(targetReal + sep)
    );
    if (selected.length === 0) {
      // Suggest only workflows a discovered fixture actually targets AND that the catalog
      // loaded; the full catalog would point the user at workflows that cannot satisfy the
      // command, and a fixture beside an unloadable workflow would too.
      const names = [...new Set(all.flatMap(f => f.workflowNames))]
        .filter(name => byName.has(name))
        .sort()
        .join(', ');
      const hint =
        names.length > 0
          ? ` Name a workflow with fixtures (${names}), a workflow folder or pack name ` +
            'containing them, or a path to such a directory.'
          : all.length === 0
            ? ' No workflow in any discovery scope declares fixtures.'
            : ' Discovered fixtures target no workflow in the discovery catalog.';
      throw new Error(`No fixtures found for '${targetName}'.${hint}`);
    }
  }

  const results = await withCapturedFixtureSource(
    options.cwd,
    options.sourceConfig,
    async captured => {
      const collected: FixtureCheckResult[] = [];
      for (const fixture of selected) {
        collected.push(...(await runOneFixture(fixture, byName, options, captured)));
      }
      return collected;
    }
  );

  return Object.freeze({
    results,
    passed: results.filter(r => r.pass).length,
    failed: results.filter(r => !r.pass).length,
  });
}

async function runOneFixture(
  fixture: DiscoveredFixture,
  byName: Map<string, WorkflowWithSource>,
  options: RunFixturesOptions,
  captured: WorkflowSourceRoots
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
        toleratedMissingStubs: [],
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
        toleratedMissingStubs: [],
        unusedStubs: [],
      },
    ];
  }

  const out: FixtureCheckResult[] = [];
  for (const entry of targets) {
    const ws = byName.get(entry.name);
    if (ws === undefined) continue;
    out.push(await checkFixture(entry.name, ws, fixture, parsed, options, captured));
  }
  return out;
}

async function checkFixture(
  workflowName: string,
  ws: WorkflowWithSource,
  fixture: DiscoveredFixture,
  parsed: ParsedFixtureFile,
  options: RunFixturesOptions,
  captured: WorkflowSourceRoots
): Promise<FixtureCheckResult> {
  const base = {
    fixture: fixture.label,
    workflow: workflowName,
    expect: parsed.declaration.expect,
  };
  try {
    const execCode = parsed.execCode;
    const inputs = resolveTopLevelInputs(ws.workflow, parsed.declaration.inputs);
    const run = (workspace: string): Promise<DryRunResult> =>
      dryRunWorkflow({
        workflow: ws.workflow,
        userMessage: '',
        cwd: options.cwd,
        stubs: parsed.stubs,
        ...(inputs ? { inputs } : {}),
        execCode,
        execWorkspace: workspace,
        sourceRoots: captured,
        ...(options.config ? { config: options.config } : {}),
        ...(options.aiProfile ? { aiProfile: options.aiProfile } : {}),
      });
    const result = execCode ? await withExecWorkspace(options.cwd, run) : await run(options.cwd);

    let failureReason: string | undefined;
    if (result.outcome !== parsed.declaration.expect) {
      failureReason = `expected ${parsed.declaration.expect}, dry-run reported ${result.outcome}`;
    } else if (parsed.declaration.expect === 'failed') {
      const failures = result.trace.filter(entry => entry.state === 'failed');
      const declared = parsed.declaration['fail-node'];
      const expected = (typeof declared === 'string' ? [declared] : [...(declared ?? [])]).sort();
      const actual = failures.map(f => f.nodeId).sort();
      if (expected.length !== actual.length || expected.some((id, i) => id !== actual[i])) {
        failureReason =
          `expected exactly the failed trace entries [${expected.join(', ')}], got ` +
          (actual.join(', ') || '(none)');
      }
    }
    // Checked whenever declared, never chained after the outcome branches above: a
    // fixture that expects a later gate to fail still has to prove the nodes before it
    // ran, and a declaration that can silently prove nothing is worse than none.
    if (failureReason === undefined && parsed.declaration.reached !== undefined) {
      const missingReached = parsed.declaration.reached.filter(
        nodeId =>
          !result.trace.some(
            entry =>
              entry.nodeId === nodeId && (entry.state === 'completed' || entry.state === 'stubbed')
          )
      );
      if (missingReached.length > 0) {
        failureReason = `required nodes did not complete: ${missingReached.join(', ')}`;
      }
    }
    if (failureReason === undefined && parsed.declaration['resolved-text-contains'] !== undefined) {
      for (const [nodeId, expectedText] of Object.entries(
        parsed.declaration['resolved-text-contains']
      )) {
        const traceEntries = result.trace.filter(
          entry =>
            entry.nodeId === nodeId && (entry.state === 'completed' || entry.state === 'stubbed')
        );
        if (traceEntries.length === 0) {
          failureReason = `expected resolved text for node '${nodeId}', but it did not complete`;
          break;
        }
        if (!traceEntries.some(entry => entry.resolvedText?.includes(expectedText) === true)) {
          failureReason = `expected node '${nodeId}' resolved text to contain ${JSON.stringify(expectedText)}`;
          break;
        }
      }
    }
    // A `trigger_rule: all_done` join tolerates its own missing stub (#2869) — it never
    // blocked this simulated outcome, so it must not block the fixture either. Only the
    // untolerated remainder still means "this fixture never verified a reached node."
    const blockingMissingStubs = result.missingStubs.filter(
      nodeId => !result.toleratedMissingStubs.includes(nodeId)
    );
    if (
      failureReason === undefined &&
      parsed.declaration.expect !== 'failed' &&
      blockingMissingStubs.length > 0
    ) {
      failureReason = `reached nodes without stubs: ${blockingMissingStubs.join(', ')}`;
    }

    return {
      ...base,
      outcome: result.outcome,
      pass: failureReason === undefined,
      ...(failureReason !== undefined ? { failureReason } : {}),
      missingStubs: result.missingStubs,
      toleratedMissingStubs: result.toleratedMissingStubs,
      unusedStubs: result.unusedStubs,
    };
  } catch (error) {
    return {
      ...base,
      pass: false,
      failureReason: (error as Error).message,
      missingStubs: [],
      toleratedMissingStubs: [],
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
    // A tolerated gap does not fail the fixture, so without this line a passing
    // run says nothing about the node it never verified.
    if (r.toleratedMissingStubs.length > 0) {
      lines.push(
        `    note: unstubbed all_done join(s) tolerated — ${r.toleratedMissingStubs.join(', ')}`
      );
    }
  }
  lines.push('', `${String(report.passed)} passed, ${String(report.failed)} failed`);
  return lines.join('\n');
}
