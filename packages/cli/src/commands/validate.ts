/**
 * CLI commands for `archon validate workflows` and `archon validate commands`.
 *
 * Thin layer over @archon/workflows validator: discovers, validates, formats output.
 */

import { providerRegistry } from '@archon/providers';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { liveSourceRoots, workflowSourceConfigFrom } from '@archon/workflows/workflow-source';
import { suggestWorkflowNames } from '@archon/workflows/router';
import {
  workflowLoadErrorName,
  type WorkflowLoadError,
  type WorkflowWithSource,
} from '@archon/workflows/schemas/workflow';
import { buildPackGraph, declaredStops, nearestPackBindings } from '@archon/workflows/pack-graph';
import { writeStdout } from '../utils/stdout';
import {
  validateWorkflowResources,
  validateProjectPackSettings,
  validateCommand,
  validateScript,
  discoverAvailableCommands,
  discoverAvailableScripts,
  makeWorkflowResult,
} from '@archon/workflows/validator';
import type {
  ValidationIssue,
  WorkflowValidationResult,
  ValidationConfig,
  ScriptValidationResult,
  CommandValidationResult,
} from '@archon/workflows/validator';
import { loadConfig, loadRepoConfig } from '@archon/core';
import { packWakeInputProblems } from '@archon/core/workflows/declared-inputs';
import { workflowValidationConfig } from '@archon/workflows/validation-config';
import type { PluginDiscovery } from '@archon/forge/discovery';
import type { WorkflowPack } from '@archon/workflows/schemas/pack-settings';
import { manifestBindingRefusals, rootPackDirs } from '@archon/workflows/pack-binding-rule';
import { PACK_DECLARATION_PATH } from '@archon/workflows/pack-settings';
import { canonicalizeProjectPath } from '@archon/paths';
import { discoverInstalledForgePlugins } from './forge';
import {
  checkGroups,
  exitProblem,
  loadPackDocument,
  ungroupedStages,
} from '@archon/workflows/pack-document';
import { replacedStillPresent, unlabelled } from '@archon/workflows/pack-graph-words';
import {
  PLUGIN_MANIFEST_FILE,
  unknownManifestKeys,
  workflowPackManifestSchema,
} from '@archon/plugin-manifest';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

/**
 * Build ValidationConfig from the repo's .archon/config.yaml
 */
async function buildValidationConfig(cwd: string): Promise<ValidationConfig> {
  try {
    const repoConfig = await loadRepoConfig(cwd);
    return {
      loadDefaultCommands: repoConfig?.defaults?.loadDefaultCommands,
      commandFolder: repoConfig?.commands?.folder,
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return {};
    console.error(`Warning: failed to load .archon/config.yaml: ${(e as Error).message}`);
    console.error('Validation will proceed with defaults (your config settings will not apply)');
    return {};
  }
}

// =============================================================================
// Output formatting
// =============================================================================

function formatIssue(issue: ValidationIssue, indent = '    '): string {
  const prefix = issue.level === 'error' ? 'ERROR' : 'WARNING';
  const nodeStr = issue.nodeId ? ` Node '${issue.nodeId}':` : '';
  let line = `${indent}${prefix} [${issue.field}]${nodeStr} ${issue.message}`;
  if (issue.hint) {
    line += `\n${indent}  ${issue.hint}`;
  }
  return line;
}

function formatValidationResult(displayName: string, issues: ValidationIssue[]): string {
  const hasErrors = issues.some(i => i.level === 'error');
  const hasWarnings = issues.some(i => i.level === 'warning');
  const statusLabel = hasErrors ? 'ERRORS' : hasWarnings ? 'WARNINGS' : 'ok';

  let output = `  ${displayName.padEnd(40, ' ')} ${statusLabel}`;
  for (const issue of issues) {
    output += '\n' + formatIssue(issue);
  }
  return output;
}

function formatWorkflowResult(result: WorkflowValidationResult): string {
  return formatValidationResult(result.workflowName, result.issues);
}

// =============================================================================
// Workflow validation command
// =============================================================================

/**
 * Validate all workflows or a specific workflow.
 * Returns exit code: 0 = all valid, 1 = errors found.
 *
 * `pluginRoot` is the directory whose `archon-plugin.json` is checked: the directory
 * the operator ran from, before `cwd` was resolved to the project root, so a plugin in
 * a repository subdirectory is checked too.
 *
 * `source` is an explicit `--workflow-source`. It is read live, as a fresh
 * `workflow run --workflow-source` discovers it: workflows, commands, scripts, the manifest
 * and the source's command settings come from the source; config, `.archon/.env` names,
 * MCP configs, skills and pack settings come from the project at `cwd`. Only the source's
 * own workflows are reported: a bundled, global or installed one stays available to resolve
 * against, but must not pass in the source's place.
 */
export async function validateWorkflowsCommand(
  cwd: string,
  name?: string,
  json?: boolean,
  forgeTrustedEnv: NodeJS.ProcessEnv = process.env,
  pluginRoot: string = cwd,
  source?: string
): Promise<number> {
  const config = await buildValidationConfig(source ?? cwd);
  const { results, workflowEntries } = await collectWorkflowResults(
    cwd,
    source,
    config,
    forgeTrustedEnv
  );
  if (source !== undefined && results.length === 0) {
    const message = `Error: no workflows found in --workflow-source ${source}`;
    if (json) await writeStdout(`${JSON.stringify({ error: message, source })}\n`);
    else console.error(message);
    return 1;
  }

  let filteredResults = results;
  if (name) {
    filteredResults = results.filter(r => r.workflowName === name);

    if (filteredResults.length === 0) {
      await reportMissingWorkflow(name, results, json, source);
      return 1;
    }
  }
  // A pack's bindings, the manifest and the pack document are not workflows, so the name filter
  // does not apply to them.
  filteredResults.push(
    ...(await packBindingResults(source ?? cwd, source === undefined ? pluginRoot : undefined)),
    ...(await manifestResults(source ?? pluginRoot)),
    ...(await packDocumentResults(source ?? pluginRoot, workflowEntries))
  );
  filteredResults = withDisplayIssues(
    filteredResults,
    await packDisplayIssues(source ?? pluginRoot, workflowEntries),
    name
  );

  filteredResults.sort((a, b) => {
    const aErrors = a.issues.filter(i => i.level === 'error').length;
    const bErrors = b.issues.filter(i => i.level === 'error').length;
    if (aErrors !== bErrors) return bErrors - aErrors;
    return a.workflowName.localeCompare(b.workflowName);
  });

  const totalErrors = filteredResults.filter(r => !r.valid).length;
  await writeWorkflowResults(cwd, source, filteredResults, totalErrors, json);

  return totalErrors > 0 ? 1 : 0;
}

/**
 * The workflows to report and the load errors. Under an explicit source this is the split a
 * fresh run makes (`prepareWorkflowSource`): the project is discovery's cwd, the source
 * supplies the roots and its own source settings, and only the source's own workflows are
 * reported. Other scopes stay in discovery so source workflows still resolve against them.
 */
async function discoverForValidation(
  cwd: string,
  workflowSource: string | undefined
): Promise<{
  workflowEntries: readonly WorkflowWithSource[];
  loadErrors: readonly WorkflowLoadError[];
}> {
  if (workflowSource === undefined) {
    const { workflows, errors } = await discoverWorkflowsWithConfig(
      cwd,
      loadConfig,
      providerRegistry
    );
    return { workflowEntries: workflows, loadErrors: errors };
  }
  const sourceConfig = workflowSourceConfigFrom(await loadConfig(workflowSource));
  const { workflows, errors } = await discoverWorkflowsWithConfig(
    cwd,
    loadConfig,
    providerRegistry,
    liveSourceRoots(workflowSource, sourceConfig)
  );
  return { workflowEntries: workflows.filter(e => e.source === 'project'), loadErrors: errors };
}

async function collectWorkflowResults(
  cwd: string,
  workflowSource: string | undefined,
  config: ValidationConfig,
  forgeTrustedEnv: NodeJS.ProcessEnv
): Promise<{
  results: WorkflowValidationResult[];
  workflowEntries: readonly WorkflowWithSource[];
}> {
  const mergedConfig = await loadConfig(cwd);
  const defaultProvider = mergedConfig.assistant;
  const { workflowEntries, loadErrors } = await discoverForValidation(cwd, workflowSource);

  const results: WorkflowValidationResult[] = [];
  // Discovered once, and only when some pack declares forge needs: it starts each plugin.
  let forgePlugins: Promise<PluginDiscovery | Error> | undefined;

  for (const loadError of loadErrors) {
    results.push(
      makeWorkflowResult(
        workflowLoadErrorName(loadError),
        [{ level: 'error', field: loadError.errorType, message: loadError.error }],
        loadError.filename
      )
    );
  }

  const stops = stopIssues(workflowEntries);
  const wakeInputs = wakeInputIssues(workflowEntries);
  for (const { workflow, source, parseWarnings } of workflowEntries) {
    const issues = await validateWorkflowResources(
      workflow,
      cwd,
      providerRegistry,
      {
        ...workflowValidationConfig(mergedConfig, config),
        // Undefined without a source: the validator then reads commands and scripts from cwd.
        sourceRoot: workflowSource,
        workflowSource: source,
      },
      defaultProvider
    );

    for (const message of await validateProjectPackSettings(cwd, workflow)) {
      issues.push({ level: 'error', field: 'pack_settings', message });
    }

    if (workflow.pack?.forge !== undefined) {
      forgePlugins ??= discoverInstalledForgePlugins(forgeTrustedEnv).catch((error: unknown) =>
        error instanceof Error ? error : new Error(String(error))
      );
      issues.push(...packForgeIssues(workflow.pack, await forgePlugins));
    }

    if (parseWarnings && parseWarnings.length > 0) {
      for (const warning of parseWarnings) {
        issues.push({ level: 'warning', field: 'parse_warning', message: warning });
      }
    }

    issues.push(...(stops.get(workflow.name) ?? []), ...(wakeInputs.get(workflow.name) ?? []));
    results.push(makeWorkflowResult(workflow.name, issues));
  }

  return { results, workflowEntries };
}

/** The workflows by pack key; a workflow outside a pack is a group of its own. */
function packGroups(entries: readonly WorkflowWithSource[]): Map<string, WorkflowWithSource[]> {
  const groups = new Map<string, WorkflowWithSource[]>();
  for (const entry of entries) {
    const key = entry.workflow.pack?.key ?? `\0${entry.workflow.name}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
}

/**
 * Each input a pack's wake binding reads, as `{ input }`, that its `wake.workflow` does not
 * declare, by that workflow's name: the run that left the wait has no such input, so the
 * read maps nothing on every start. An error, as `archon pack bindings` refuses it. A
 * `wake.workflow` that is not a stage of the pack is `packBindingResults`'.
 */
function wakeInputIssues(entries: readonly WorkflowWithSource[]): Map<string, ValidationIssue[]> {
  const issues = new Map<string, ValidationIssue[]>();
  for (const workflows of packGroups(entries).values()) {
    const stages = workflows.map(entry => entry.workflow);
    for (const [id, binding] of Object.entries(nearestPackBindings(workflows) ?? {})) {
      const found = packWakeInputProblems(binding, stages);
      if (found === undefined) continue;
      for (const problem of found.problems)
        issues.set(found.waiting, [
          ...(issues.get(found.waiting) ?? []),
          {
            level: 'error',
            field: 'pack_bindings',
            message: `binding '${id}' in ${PACK_DECLARATION_PATH}: ${problem}`,
            hint: 'Declare the input in the waiting workflow, or map it from somewhere else; a wake start reads the inputs of the run that left the wait.',
          },
        ]);
    }
  }
  return issues;
}

/** What a run leaves, named in the singular, for a stop that holds only without it. */
const LEFT = { asks: 'ask', waits: 'wait' } as const;

/**
 * Each outcome of a step workflow that stops its item when only the bindings its pack
 * declares start stages, by workflow name: a pack's stages read together with the pack's
 * declarations, a workflow outside a pack on its own, which no declaration starts anything
 * from. A warning: a deliberate stop is legal, and the attention queue lists the item when
 * it happens.
 */
function stopIssues(entries: readonly WorkflowWithSource[]): Map<string, ValidationIssue[]> {
  const issues = new Map<string, ValidationIssue[]>();
  for (const [key, workflows] of packGroups(entries)) {
    const stages = workflows.map(entry => entry.workflow);
    for (const { stage, outcome, unless } of declaredStops(
      key,
      stages,
      nearestPackBindings(workflows)
    ))
      issues.set(stage, [
        ...(issues.get(stage) ?? []),
        {
          level: 'warning',
          field: 'stops',
          message:
            unless.length === 0
              ? `outcome '${outcome}' starts no step on the item, leaves no ask or wait and ends nothing: a run that ends with it stops its item`
              : `outcome '${outcome}' starts no step on the item and ends nothing: a run that ends with it and leaves no ${unless.map(part => LEFT[part]).join(' or ')} stops its item`,
          hint: 'List it in returns.ends when it finishes the item, bind a step on it (a stage that observes its item does not move it on), or declare observes: true when the workflow is not a step of its item. A stop is listed in `archon workflow attention`.',
        },
      ]);
  }
  return issues;
}

/**
 * The stages a group of the pack at `packDir` may hold, and the ones it must: with the
 * bindings the pack declares, its in-flow stages, read as `archon pack graph` reads them
 * before anything is installed (declared arrows mark a stage in flow on their own). A pack
 * that declares no bindings has no flow, so a group may hold any workflow of the pack and no
 * stage must be in one. A source pack is keyed by its manifest's `name`; a plugin root whose
 * pack discovery did not reach is checked against every workflow discovered.
 */
async function packStages(
  packDir: string,
  entries: readonly WorkflowWithSource[]
): Promise<{ allowed: string[]; required: string[]; graph?: ReturnType<typeof buildPackGraph> }> {
  const manifest = workflowPackManifestSchema.safeParse(
    JSON.parse(await readFile(join(packDir, PLUGIN_MANIFEST_FILE), 'utf-8'))
  );
  const key = manifest.success ? manifest.data.name : undefined;
  const own = entries.filter(entry => entry.workflow.pack?.key === key);
  const declared = nearestPackBindings(own);
  if (own.length === 0 || declared === undefined) {
    // A document names a stage as its pack authored it, as an installed catalog's name need not.
    const names = (own.length === 0 ? entries : own).map(
      ({ workflow }) => workflow.pack?.workflow ?? workflow.name
    );
    return { allowed: names, required: [] };
  }
  const graph = buildPackGraph({
    packKey: key ?? '',
    stages: own.map(entry => entry.workflow),
    declared,
    installed: [],
    workflows: entries.map(entry => entry.workflow),
    discoveryErrors: [],
  });
  const inFlow = graph.stages.filter(stage => stage.inFlow).map(stage => stage.workflow);
  return { allowed: inFlow, required: inFlow, graph };
}

/**
 * What is wrong with the pack's document (the manifest's `document`, else its
 * `how-it-works.md`): errors when it is missing or does not read, when a group names a stage
 * that is not in the pack's flow or that another group holds, when an in-flow stage is in
 * no group, and when `exit` names a stage not in the flow (`pack-document.ts`, the checks
 * `archon pack graph` makes). A frontmatter key this
 * Archon does not read is a warning, as an unknown manifest key is.
 */
async function packDocumentResults(
  packDir: string,
  entries: readonly WorkflowWithSource[]
): Promise<WorkflowValidationResult[]> {
  const read = await loadPackDocument(packDir);
  if (read.document === null) return [];
  const hint = read.fallback
    ? `Fix ${read.document}, or name the pack's document in the manifest's \`document\`.`
    : `Fix ${read.document} or the manifest's document path.`;
  const stages = await packStages(packDir, entries);
  const errors = [
    ...read.problems,
    ...checkGroups(read.groups, stages.allowed).problems,
    ...ungroupedStages(read.groups, stages.required),
    ...exitProblem(read.exit, stages.allowed),
  ];
  const issues = [
    ...errors.map(
      (message): ValidationIssue => ({
        level: 'error',
        field: 'pack_document',
        message,
        hint,
      })
    ),
    ...read.warnings.map(
      (message): ValidationIssue => ({
        level: 'warning',
        field: 'pack_document',
        message,
        hint: `Remove the key from ${read.document}, or check its spelling: a key a newer Archon reads is ignored by this one.`,
      })
    ),
  ];
  return issues.length > 0
    ? [makeWorkflowResult(PLUGIN_MANIFEST_FILE, issues, PLUGIN_MANIFEST_FILE)]
    : [];
}

/**
 * What the pack's in-flow stages leave a reader without words for, as warnings (a reader shows
 * the id instead), and a `display.replaces` naming a stage the pack still has, as an error
 * (`pack-graph-words.ts`), by the stage's workflow name. A folder with no pack manifest, or a
 * pack with no flow, has nothing to check.
 */
async function packDisplayIssues(
  packDir: string,
  entries: readonly WorkflowWithSource[]
): Promise<Map<string, ValidationIssue[]>> {
  const byStage = new Map<string, ValidationIssue[]>();
  try {
    await access(join(packDir, PLUGIN_MANIFEST_FILE));
  } catch {
    return byStage;
  }
  let graph: ReturnType<typeof buildPackGraph> | undefined;
  try {
    ({ graph } = await packStages(packDir, entries));
  } catch {
    // A manifest that does not read is reported by `manifestResults`.
    return byStage;
  }
  if (graph === undefined) return byStage;
  const add = (stage: string, issue: ValidationIssue): void => {
    byStage.set(stage, [...(byStage.get(stage) ?? []), issue]);
  };
  for (const { stage, message, hint } of unlabelled(graph))
    add(stage, { level: 'warning', field: 'display', message, hint });
  for (const { stage, message, hint } of replacedStillPresent(graph))
    add(stage, { level: 'error', field: 'display', message, hint });
  return byStage;
}

/**
 * `results` with each stage's display issues added to its workflow's own result, so a stage
 * reads as one entry. A stage with no result of its own gets one, unless `name` filters it out.
 */
function withDisplayIssues(
  results: WorkflowValidationResult[],
  byStage: ReadonlyMap<string, ValidationIssue[]>,
  name: string | undefined
): WorkflowValidationResult[] {
  const merged = results.map(result => {
    const issues = byStage.get(result.workflowName);
    return issues === undefined
      ? result
      : makeWorkflowResult(result.workflowName, [...result.issues, ...issues], result.filename);
  });
  for (const [stage, issues] of byStage)
    if (
      !results.some(result => result.workflowName === stage) &&
      (name === undefined || name === stage)
    )
      merged.push(makeWorkflowResult(stage, issues));
  return merged;
}

/**
 * The plugin root's own manifest. Keys this Archon ignores are warnings: readers strip
 * them so a newer Archon can add a field, and the author still sees a typo. A declared
 * skill folder without a `SKILL.md` is an error, because install refuses it. Schema
 * failures are discovery load errors and are not repeated here. A binding to a workflow
 * the manifest does not list is `packBindingResults`'.
 */
async function manifestResults(cwd: string): Promise<WorkflowValidationResult[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(cwd, PLUGIN_MANIFEST_FILE), 'utf-8'));
  } catch {
    // No manifest is the common case. An unreadable or invalid pack manifest is already a
    // load error from discovery, and another kind's manifest is not this command's subject.
    return [];
  }
  const issues = unknownManifestKeys(raw).map(
    (key): ValidationIssue => ({
      level: 'warning',
      field: 'manifest_unknown_key',
      message: `unknown key '${key}' is ignored`,
      hint: 'Check the spelling. A key a newer Archon reads is ignored by this one.',
    })
  );
  const pack = workflowPackManifestSchema.safeParse(raw);
  const skill = pack.success ? pack.data.skill : undefined;
  if (skill) {
    const skillFile = join(cwd, skill.path, 'SKILL.md');
    const present = await stat(skillFile).then(
      info => info.isFile(),
      () => false
    );
    if (!present) {
      issues.push({
        level: 'error',
        field: 'manifest_skill',
        message: `skill "${skill.name}" names ${skill.path}, which has no SKILL.md`,
        hint: 'archon plugin add refuses this pack until the folder holds a SKILL.md.',
      });
    }
  }
  return issues.length > 0
    ? [makeWorkflowResult(PLUGIN_MANIFEST_FILE, issues, PLUGIN_MANIFEST_FILE)]
    : [];
}

/**
 * Each pack whose `.pack/pack.yaml` binds a workflow its manifest does not list as an
 * entrypoint (`manifestBindingRefusals`), with the refusal `archon pack bindings` gives. The
 * packs checked are those of `root`, the project or explicit source, and the pack folder at
 * or above `pluginRoot` that holds the nearest `archon-plugin.json` (a plugin kept in a
 * repository subdirectory, which discovery does not read). Each directory is read once, so
 * the result is the same from whatever directory of the project validation runs in.
 */
async function packBindingResults(
  root: string,
  pluginRoot: string | undefined
): Promise<WorkflowValidationResult[]> {
  const dirs = new Map<string, string | undefined>();
  for (const { dir, key } of await rootPackDirs(root))
    dirs.set(await canonicalizeProjectPath(dir), key);
  const located = pluginRoot === undefined ? undefined : await nearestManifestDir(pluginRoot, root);
  if (located !== undefined && !dirs.has(located)) dirs.set(located, undefined);
  const results: WorkflowValidationResult[] = [];
  for (const [dir, key] of dirs) {
    try {
      const found = await manifestBindingRefusals(dir, key);
      if (found !== undefined) results.push(...refusalResult(found.key, found.refusals));
    } catch (error) {
      results.push(...refusalResult(key ?? dir, [(error as Error).message]));
    }
  }
  return results;
}

/** One pack's refusals as a result under its declaration, or nothing when there are none. */
function refusalResult(key: string, messages: readonly string[]): WorkflowValidationResult[] {
  const issues = messages.map(
    (message): ValidationIssue => ({
      level: 'error',
      field: 'pack_bindings',
      message,
      hint: `A pack copy dispatches only the entrypoints its ${PLUGIN_MANIFEST_FILE} lists: bind one of them, or list this workflow there.`,
    })
  );
  return issues.length > 0 ? [makeWorkflowResult(`${key}: ${PACK_DECLARATION_PATH}`, issues)] : [];
}

/**
 * The nearest directory at or above `from`, up to `root`, holding an `archon-plugin.json`;
 * only `from` itself when it lies outside `root`. Canonical, as the root from git is.
 */
async function nearestManifestDir(from: string, root: string): Promise<string | undefined> {
  const top = await canonicalizeProjectPath(root);
  let dir = await canonicalizeProjectPath(from);
  const inside = !relative(top, dir).startsWith('..');
  for (;;) {
    const present = await stat(join(dir, PLUGIN_MANIFEST_FILE)).then(
      () => true,
      () => false
    );
    if (present) return dir;
    if (!inside || dir === top || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

/**
 * A declared forge capability no installed plugin advertises. A warning, not an error:
 * which plugins an install has is a fact about the install, not a defect in the pack.
 */
function packForgeIssues(
  pack: WorkflowPack,
  discovery: PluginDiscovery | Error
): ValidationIssue[] {
  if (discovery instanceof Error) {
    return [
      {
        level: 'warning',
        field: 'pack_forge',
        message: `could not discover forge plugins to check pack '${pack.key}': ${discovery.message}`,
      },
    ];
  }
  const installed = discovery.plugins.map(p => `${p.metadata.name} ${p.metadata.version}`);
  const unknown = (pack.forge?.operations ?? []).filter(
    operation => !discovery.plugins.some(p => p.metadata.capabilities.includes(operation))
  );
  return [
    ...unknown.map(
      (operation): ValidationIssue => ({
        level: 'warning',
        field: 'pack_forge',
        message: `pack '${pack.key}' needs forge operation '${operation}', which no installed forge plugin advertises (installed: ${installed.length > 0 ? installed.join(', ') : 'none'})`,
        hint: 'A run of this pack is refused at start until a plugin serves it. Update a plugin `archon plugin list` shows a receipt for with `archon plugin update <id>` (or the repair command the list prints), replace one Archon did not install, update Archon for one it runs from its source checkout, or install one with `archon plugin add <owner/repo[/path][@tag]>`.',
      })
    ),
    ...discovery.unavailable.map(
      (error): ValidationIssue => ({
        level: 'warning',
        field: 'pack_forge',
        message: `forge plugin unavailable: ${error.message}`,
      })
    ),
  ];
}

async function reportMissingWorkflow(
  name: string,
  results: WorkflowValidationResult[],
  json: boolean | undefined,
  source: string | undefined
): Promise<void> {
  const allNames = results.map(r => r.workflowName);
  const similar = suggestWorkflowNames(
    name,
    allNames.map(name => ({ name }))
  );
  if (json) {
    await writeStdout(
      `${JSON.stringify({
        error: `Workflow '${name}' not found${source === undefined ? '' : ` in --workflow-source ${source}`}`,
        suggestions: similar,
        available: allNames,
      })}\n`
    );
  } else {
    console.error(
      `Workflow '${name}' not found${source === undefined ? '' : ` in --workflow-source ${source}`}.`
    );
    if (similar.length > 0) {
      console.error(`Did you mean: ${similar.map(s => `'${s}'`).join(', ')}?`);
    }
    console.error(`Available workflows: ${allNames.join(', ')}`);
  }
}

async function writeWorkflowResults(
  cwd: string,
  source: string | undefined,
  results: WorkflowValidationResult[],
  totalErrors: number,
  json: boolean | undefined
): Promise<void> {
  const totalWarnings = results.filter(r => r.issues.some(i => i.level === 'warning')).length;

  if (json) {
    await writeStdout(
      `${JSON.stringify({
        ...(source === undefined ? {} : { source }),
        results,
        summary: {
          total: results.length,
          valid: results.length - totalErrors,
          errors: totalErrors,
          warnings: totalWarnings,
        },
      })}\n`
    );
  } else {
    console.log(
      source === undefined
        ? `\nValidating workflows in ${cwd}\n`
        : `\nValidating workflows from --workflow-source ${source} (project ${cwd})\n`
    );
    for (const result of results) {
      console.log(formatWorkflowResult(result));
    }
    console.log(
      `\nResults: ${results.length - totalErrors} valid, ${totalErrors} with errors${totalWarnings > 0 ? `, ${totalWarnings} with warnings` : ''}`
    );
  }
}

// =============================================================================
// Command and script validation command
// =============================================================================

function formatScriptResult(result: ScriptValidationResult): string {
  return formatValidationResult(`[script] ${result.scriptName}`, result.issues);
}

/**
 * Validate all commands or a specific command.
 * Also validates scripts from .archon/scripts/ alongside commands.
 * Returns exit code: 0 = all valid, 1 = errors found.
 */
export async function validateCommandsCommand(
  cwd: string,
  name?: string,
  jsonOutput?: boolean
): Promise<number> {
  const config = await buildValidationConfig(cwd);

  if (name) {
    const result = await validateCommand(name, cwd, config);
    if (jsonOutput) await writeStdout(`${JSON.stringify(result)}\n`);
    else printCommandResult(result, '\n  ');
    return result.valid ? 0 : 1;
  }

  // Validate all commands
  const allCommands = await discoverAvailableCommands(cwd, config);
  const commandResults = await Promise.all(
    allCommands.map(cmd => validateCommand(cmd, cwd, config))
  );

  // Validate all scripts
  const allScripts = await discoverAvailableScripts(cwd);
  const scriptResults = await Promise.all(allScripts.map(s => validateScript(s.name, cwd)));

  const totalCommandErrors = commandResults.filter(r => !r.valid).length;
  const totalScriptErrors = scriptResults.filter(r => !r.valid).length;
  const totalErrors = totalCommandErrors + totalScriptErrors;

  await writeCommandResults(cwd, commandResults, scriptResults, totalErrors, jsonOutput);

  return totalErrors > 0 ? 1 : 0;
}

function printCommandResult(result: CommandValidationResult, prefix = '  '): void {
  const statusLabel = result.valid ? 'ok' : 'ERRORS';
  console.log(`${prefix}${result.commandName.padEnd(40, ' ')} ${statusLabel}`);
  for (const issue of result.issues) {
    console.log(formatIssue(issue));
  }
}

async function writeCommandResults(
  cwd: string,
  commandResults: CommandValidationResult[],
  scriptResults: ScriptValidationResult[],
  totalErrors: number,
  jsonOutput: boolean | undefined
): Promise<void> {
  if (jsonOutput) {
    await writeStdout(
      `${JSON.stringify({
        results: commandResults,
        scripts: scriptResults,
        summary: {
          total: commandResults.length + scriptResults.length,
          valid: commandResults.length + scriptResults.length - totalErrors,
          errors: totalErrors,
        },
      })}\n`
    );
  } else {
    if (commandResults.length === 0 && scriptResults.length === 0) {
      console.log('\nNo commands or scripts found.');
      return;
    }

    console.log(`\nValidating commands and scripts in ${cwd}\n`);
    for (const result of commandResults) {
      printCommandResult(result);
    }
    for (const result of scriptResults) {
      console.log(formatScriptResult(result));
    }
    console.log(
      `\nResults: ${commandResults.length + scriptResults.length - totalErrors} valid, ${totalErrors} with errors`
    );
  }
}
