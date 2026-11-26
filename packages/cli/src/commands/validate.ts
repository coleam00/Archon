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
import { workflowValidationConfig } from '@archon/workflows/validation-config';
import type { PluginDiscovery } from '@archon/forge/discovery';
import type { WorkflowPack } from '@archon/workflows/schemas/pack-settings';
import { bindingWorkflowNames, packWorkflowName } from '@archon/workflows/pack-graph';
import {
  loadPackDeclaration,
  PACK_DECLARATION_PATH,
  PackSettingsError,
  type PackDeclaration,
} from '@archon/workflows/pack-settings';
import { discoverInstalledForgePlugins } from './forge';
import { loadPackDocument } from '@archon/workflows/pack-document';
import {
  PLUGIN_MANIFEST_FILE,
  unknownManifestKeys,
  workflowPackManifestSchema,
} from '@archon/plugin-manifest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

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
  const results = await collectWorkflowResults(cwd, source, config, forgeTrustedEnv);
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
  // The manifest is not a workflow, so the name filter does not apply to it.
  filteredResults.push(...(await manifestResults(source ?? pluginRoot)));
  filteredResults.push(
    ...(await packDocumentResults(
      source ?? pluginRoot,
      results.map(result => result.workflowName)
    ))
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
): Promise<WorkflowValidationResult[]> {
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

    results.push(makeWorkflowResult(workflow.name, issues));
  }

  return results;
}

/**
 * What is wrong with the document the pack's manifest names: it is missing, its frontmatter
 * does not read, or a group names something that is not a workflow of the pack. Whether a
 * named workflow is a stage of the flow depends on the bindings an install has, which
 * `archon pack graph` checks.
 */
async function packDocumentResults(
  cwd: string,
  workflowNames: readonly string[]
): Promise<WorkflowValidationResult[]> {
  const read = await loadPackDocument(cwd);
  if (read.document === null) return [];
  const unknown = read.groups.flatMap(group =>
    group.stages
      .filter(stage => packWorkflowName(workflowNames, stage) === undefined)
      .map(stage => `group '${group.name}' names '${stage}', which is not a workflow of the pack`)
  );
  const issues = [...read.problems, ...unknown].map(
    (message): ValidationIssue => ({
      level: 'error',
      field: 'pack_document',
      message,
      hint: `Fix ${read.document ?? 'the document'} or the manifest's document path.`,
    })
  );
  return issues.length > 0
    ? [makeWorkflowResult(PLUGIN_MANIFEST_FILE, issues, PLUGIN_MANIFEST_FILE)]
    : [];
}

/**
 * The plugin root's own manifest. Keys this Archon ignores are warnings: readers strip
 * them so a newer Archon can add a field, and the author still sees a typo. A declared
 * skill folder without a `SKILL.md` is an error, because install refuses it. So is a
 * binding in `.pack/pack.yaml` that names a workflow the manifest does not list as an
 * entrypoint: an installed copy dispatches only entrypoints, so `pack bindings` refuses it
 * there, while a folder source sees every workflow and would accept it. Schema failures
 * are discovery load errors and are not repeated here.
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
  if (pack.success) issues.push(...(await bindingEntrypointIssues(cwd, pack.data.entrypoints)));
  return issues.length > 0
    ? [makeWorkflowResult(PLUGIN_MANIFEST_FILE, issues, PLUGIN_MANIFEST_FILE)]
    : [];
}

/**
 * Each workflow a pack's bindings name that its manifest does not list as an entrypoint,
 * decided by `packWorkflowName`, the resolver `pack bindings` uses on an installed copy.
 * A binding names its own pack's stage by the bare key; `pack bindings` adds the installed
 * `owner/plugin:` prefix. A qualified name is refused, because the owner is set at install
 * and a pack folder cannot say whether a prefix is its own.
 */
async function bindingEntrypointIssues(
  cwd: string,
  entrypoints: Readonly<Record<string, string>>
): Promise<ValidationIssue[]> {
  let declaration: PackDeclaration;
  try {
    declaration = await loadPackDeclaration(cwd, '.');
  } catch (error) {
    // An invalid declaration is already a load error on every workflow of the pack.
    if (error instanceof PackSettingsError) return [];
    throw error;
  }
  const listed = Object.keys(entrypoints);
  return Object.entries(declaration.bindings ?? {}).flatMap(([id, binding]) =>
    bindingWorkflowNames(binding)
      .filter(name => packWorkflowName(listed, name) === undefined)
      .map(
        (name): ValidationIssue => ({
          level: 'error',
          field: 'manifest_entrypoints',
          message: `binding '${id}' in ${PACK_DECLARATION_PATH} names workflow '${name}', which ${PLUGIN_MANIFEST_FILE} does not list as an entrypoint`,
          hint: name.includes(':')
            ? `Name a stage of this pack by its bare name, as the pack writes it; archon pack bindings adds the installed prefix. Bind one it lists: ${listed.join(', ')}.`
            : `An installed copy refuses this binding at archon pack bindings. List '${name}' under entrypoints, or bind one it lists: ${listed.join(', ')}.`,
        })
      )
  );
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
