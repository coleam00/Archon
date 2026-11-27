/**
 * CLI commands for `archon validate workflows` and `archon validate commands`.
 *
 * Thin layer over @archon/workflows validator: discovers, validates, formats output.
 */

import { providerRegistry } from '@archon/providers';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import {
  liveSourceRoots,
  workflowSourceConfigFrom,
  type WorkflowSourceRoots,
} from '@archon/workflows/workflow-source';
import { suggestWorkflowNames } from '@archon/workflows/router';
import {
  workflowLoadErrorName,
  type WorkflowLoadError,
  type WorkflowWithSource,
} from '@archon/workflows/schemas/workflow';
import {
  declaredStops,
  nearestPackBindings,
  packBindingRefusals,
  packBindingScope,
  readPackManifest,
} from '@archon/workflows/pack-graph';
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
import {
  loadPackDeclaration,
  PACK_DECLARATION_PATH,
  PackSettingsError,
} from '@archon/workflows/pack-settings';
import { canonicalizeProjectPath } from '@archon/paths';
import { discoverInstalledForgePlugins } from './forge';
import {
  PLUGIN_MANIFEST_FILE,
  unknownManifestKeys,
  workflowPackManifestSchema,
} from '@archon/plugin-manifest';
import { readFile, stat } from 'node:fs/promises';
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
  const { results, packs } = await collectWorkflowResults(
    cwd,
    source,
    config,
    forgeTrustedEnv,
    pluginRoot
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
  // A pack's bindings and the manifest are not workflows, so the name filter does not apply.
  filteredResults.push(...packs, ...(await manifestResults(source ?? pluginRoot)));

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
  /** The roots discovery read, so a pack's directory is where its workflows came from. */
  roots: WorkflowSourceRoots;
}> {
  if (workflowSource === undefined) {
    const { workflows, errors } = await discoverWorkflowsWithConfig(
      cwd,
      loadConfig,
      providerRegistry
    );
    return { workflowEntries: workflows, loadErrors: errors, roots: liveSourceRoots(cwd) };
  }
  const sourceConfig = workflowSourceConfigFrom(await loadConfig(workflowSource));
  const roots = liveSourceRoots(workflowSource, sourceConfig);
  const { workflows, errors } = await discoverWorkflowsWithConfig(
    cwd,
    loadConfig,
    providerRegistry,
    roots
  );
  return {
    workflowEntries: workflows.filter(e => e.source === 'project'),
    loadErrors: errors,
    roots,
  };
}

async function collectWorkflowResults(
  cwd: string,
  workflowSource: string | undefined,
  config: ValidationConfig,
  forgeTrustedEnv: NodeJS.ProcessEnv,
  pluginRoot: string
): Promise<{ results: WorkflowValidationResult[]; packs: WorkflowValidationResult[] }> {
  const mergedConfig = await loadConfig(cwd);
  const defaultProvider = mergedConfig.assistant;
  const { workflowEntries, loadErrors, roots } = await discoverForValidation(cwd, workflowSource);

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

  // Under an explicit source the source's packs are discovered; the invocation directory is not read.
  const packs = await packBindingResults(
    roots,
    workflowEntries,
    workflowSource === undefined ? { pluginRoot, projectRoot: cwd } : undefined
  );
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

  return { results, packs };
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
 * Each pack whose bindings name a workflow it does not let them bind (`packBindingScope`),
 * with the refusal `archon pack bindings` gives: every pack discovery returns, so the
 * result is the same from whatever directory of the project validation runs in. A plugin
 * kept in a repository subdirectory is no pack discovery reads, so the workflow-pack
 * manifest at or above `invokedFrom.pluginRoot` names it, unless discovery checked it.
 */
async function packBindingResults(
  roots: WorkflowSourceRoots,
  entries: readonly WorkflowWithSource[],
  invokedFrom: { pluginRoot: string; projectRoot: string } | undefined
): Promise<WorkflowValidationResult[]> {
  const results: WorkflowValidationResult[] = [];
  const checked = new Set<string>();
  for (const workflows of packGroups(entries).values()) {
    const key = workflows[0]?.workflow.pack?.key;
    if (key === undefined) continue;
    try {
      const scope = await packBindingScope(roots, workflows);
      if (scope === undefined) continue;
      if (scope.dir !== null) checked.add(await canonicalizeProjectPath(scope.dir));
      results.push(...refusalResult(key, packBindingRefusals(key, scope.bindings, scope.names)));
    } catch (error) {
      results.push(...refusalResult(key, [(error as Error).message]));
    }
  }
  if (invokedFrom === undefined) return results;
  try {
    const dir = await invokedPackDir(invokedFrom.pluginRoot, invokedFrom.projectRoot);
    if (dir === undefined || checked.has(dir)) return results;
    const manifest = await readPackManifest(dir);
    const declaration = await loadPackDeclaration(dir, '.').catch((error: unknown) => {
      // An invalid declaration is reported where the pack is used; nothing binds here.
      if (error instanceof PackSettingsError) return undefined;
      throw error;
    });
    if (manifest !== undefined && declaration?.bindings !== undefined)
      results.push(
        ...refusalResult(
          manifest.name,
          packBindingRefusals(manifest.name, declaration.bindings, manifest.entrypoints)
        )
      );
  } catch (error) {
    results.push(...refusalResult(invokedFrom.pluginRoot, [(error as Error).message]));
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
 * The directory at or above `from`, up to `projectRoot`, whose `archon-plugin.json` is a
 * workflow pack's, or undefined. Only `from` is asked when it is outside the project. Paths
 * are canonicalized: the root comes from git resolution, `from` may not.
 */
async function invokedPackDir(from: string, projectRoot: string): Promise<string | undefined> {
  const root = await canonicalizeProjectPath(projectRoot);
  let dir = await canonicalizeProjectPath(from);
  const inside = dir === root || !relative(root, dir).startsWith('..');
  for (;;) {
    if ((await readPackManifest(dir)) !== undefined) return dir;
    if (!inside || dir === root || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
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
 * The plugin root's own manifest. Keys this Archon ignores are warnings: readers strip
 * them so a newer Archon can add a field, and the author still sees a typo. A declared
 * skill folder without a `SKILL.md` is an error, because install refuses it. Schema
 * failures are discovery load errors and are not repeated here. A binding to a workflow
 * the manifest does not list is `packBindingResults`', for every pack discovery reads.
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
