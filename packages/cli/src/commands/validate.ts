/**
 * CLI commands for `archon validate workflows` and `archon validate commands`.
 *
 * Thin layer over @archon/workflows validator: discovers, validates, formats output.
 */

import { providerRegistry } from '@archon/providers';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { suggestWorkflowNames } from '@archon/workflows/router';
import { workflowLoadErrorName } from '@archon/workflows/schemas/workflow';
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
import { discoverInstalledForgePlugins } from './forge';
import { PLUGIN_MANIFEST_FILE, unknownManifestKeys } from '@archon/plugin-manifest';
import { readFile } from 'node:fs/promises';
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
 */
export async function validateWorkflowsCommand(
  cwd: string,
  name?: string,
  json?: boolean,
  forgeTrustedEnv: NodeJS.ProcessEnv = process.env,
  pluginRoot: string = cwd
): Promise<number> {
  const config = await buildValidationConfig(cwd);
  const results = await collectWorkflowResults(cwd, config, forgeTrustedEnv);

  let filteredResults = results;
  if (name) {
    filteredResults = results.filter(r => r.workflowName === name);

    if (filteredResults.length === 0) {
      await reportMissingWorkflow(name, results, json);
      return 1;
    }
  }
  // The manifest is not a workflow, so the name filter does not apply to it.
  filteredResults.push(...(await unknownManifestKeyResults(pluginRoot)));

  filteredResults.sort((a, b) => {
    const aErrors = a.issues.filter(i => i.level === 'error').length;
    const bErrors = b.issues.filter(i => i.level === 'error').length;
    if (aErrors !== bErrors) return bErrors - aErrors;
    return a.workflowName.localeCompare(b.workflowName);
  });

  const totalErrors = filteredResults.filter(r => !r.valid).length;
  await writeWorkflowResults(cwd, filteredResults, totalErrors, json);

  return totalErrors > 0 ? 1 : 0;
}

async function collectWorkflowResults(
  cwd: string,
  config: ValidationConfig,
  forgeTrustedEnv: NodeJS.ProcessEnv
): Promise<WorkflowValidationResult[]> {
  const mergedConfig = await loadConfig(cwd);
  const defaultProvider = mergedConfig.assistant;
  const { workflows: workflowEntries, errors: loadErrors } = await discoverWorkflowsWithConfig(
    cwd,
    loadConfig,
    providerRegistry
  );

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
        workflowSource: source,
      },
      defaultProvider
    );

    if (workflow.pack !== undefined) {
      for (const message of await validateProjectPackSettings(cwd, workflow.pack)) {
        issues.push({ level: 'error', field: 'pack_settings', message });
      }
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
 * Manifest keys this Archon ignores. Readers strip them so a newer Archon can add a
 * field; the author still sees a typo here, as a warning that does not fail validate.
 */
async function unknownManifestKeyResults(cwd: string): Promise<WorkflowValidationResult[]> {
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
        hint: 'A run of this pack is refused at start until a plugin serves it: install one with `archon plugin add <owner/repo[/path][@tag]>`, or update an installed one with `archon plugin update <id>` (find its id with `archon plugin list`).',
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
  json: boolean | undefined
): Promise<void> {
  const allNames = results.map(r => r.workflowName);
  const similar = suggestWorkflowNames(
    name,
    allNames.map(name => ({ name }))
  );
  if (json) {
    await writeStdout(
      `${JSON.stringify({
        error: `Workflow '${name}' not found`,
        suggestions: similar,
        available: allNames,
      })}\n`
    );
  } else {
    console.error(`Workflow '${name}' not found.`);
    if (similar.length > 0) {
      console.error(`Did you mean: ${similar.map(s => `'${s}'`).join(', ')}?`);
    }
    console.error(`Available workflows: ${allNames.join(', ')}`);
  }
}

async function writeWorkflowResults(
  cwd: string,
  results: WorkflowValidationResult[],
  totalErrors: number,
  json: boolean | undefined
): Promise<void> {
  const totalWarnings = results.filter(r => r.issues.some(i => i.level === 'warning')).length;

  if (json) {
    await writeStdout(
      `${JSON.stringify({
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
    console.log(`\nValidating workflows in ${cwd}\n`);
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
