import { join, relative } from 'node:path';
import { findIgnoredFiles } from '@archon/git/ignored-files';
import { isPathInside } from '@archon/paths';
import { collectFileBackedCommandNames } from '../command-file';
import {
  collectExecInputValidationTargets,
  inlineExecInputSource,
  type ExecInputSource,
} from '../exec-input-validation';
import type { WorkflowDefinition } from '../schemas';
import { parsePackagedResourceReference } from '../packaged-workflow';
import { resolveCommandSourceForScan } from './command-scan';
import type { DiscoveryContext } from './context';
import type { ScopeFile } from './load-dir';
import { getLog } from './log';

export async function collectIgnoredSourceWarnings(
  context: DiscoveryContext,
  files: readonly ScopeFile[],
  namedScripts: ReadonlyMap<string, ExecInputSource>
): Promise<string[]> {
  const { gitIgnoreRoot, roots } = context;
  if (!gitIgnoreRoot || roots.kind !== 'live' || roots.project === null) return [];
  const candidates = new Map<string, Set<string>>();
  const warnings: string[] = [];
  const add = (path: string | undefined, name: string): void => {
    if (path === undefined || !isPathInside(gitIgnoreRoot, path)) return;
    const repoPath = relative(gitIgnoreRoot, path);
    const owners = candidates.get(repoPath) ?? new Set<string>();
    owners.add(name);
    candidates.set(repoPath, owners);
  };
  for (const { workflow, source, filePath } of files) {
    if (source !== 'project') continue;
    add(filePath, workflow.name);
    const commands = await projectCommandPaths(context, workflow);
    warnings.push(...commands.warnings);
    for (const path of commands.paths) add(path, workflow.name);
    for (const path of projectScriptPaths(roots.project, workflow, namedScripts))
      add(path, workflow.name);
  }
  const ignored = await checkSourcePaths(gitIgnoreRoot, [...candidates.keys()].sort(), warnings);
  for (const path of ignored.sort()) {
    const owners = [...(candidates.get(path) ?? [])].sort().map(name => JSON.stringify(name));
    warnings.push(
      `Git ignores ${JSON.stringify(path)} (workflows: ${owners.join(', ')}); it may be missing from other checkouts.`
    );
  }
  return warnings;
}

async function checkSourcePaths(
  root: string,
  paths: readonly string[],
  warnings: string[]
): Promise<string[]> {
  try {
    return await findIgnoredFiles(root, paths);
  } catch (error) {
    getLog().warn({ err: error }, 'workflow_source_ignore_check_failed');
    if (paths.length === 1) {
      warnings.push(
        `Could not check workflow source file ${JSON.stringify(paths[0])} against Git ignore rules.`
      );
      return [];
    }
    // Git rejects an entire batch when a path crosses a submodule boundary.
    const ignored: string[] = [];
    for (const path of paths) ignored.push(...(await checkSourcePaths(root, [path], warnings)));
    return ignored;
  }
}

async function projectCommandPaths(
  context: DiscoveryContext,
  workflow: WorkflowDefinition
): Promise<{ paths: string[]; warnings: string[] }> {
  const paths: string[] = [];
  const warnings: string[] = [];
  for (const command of collectFileBackedCommandNames(workflow.nodes)) {
    try {
      const resolved = await resolveCommandSourceForScan(
        context.roots,
        command,
        context.commandScan
      );
      if (resolved.content !== null && typeof resolved.content !== 'string') {
        throw resolved.content;
      }
      if (resolved.file?.source === 'project') paths.push(resolved.file.path);
    } catch (error) {
      getLog().warn({ err: error, workflow: workflow.name }, 'workflow_source_ignore_check_failed');
      warnings.push(
        `Could not check Git ignores for command ${JSON.stringify(command)} in workflow ${JSON.stringify(workflow.name)}.`
      );
    }
  }
  return { paths, warnings };
}

function projectScriptPaths(
  project: string,
  workflow: WorkflowDefinition,
  namedScripts: ReadonlyMap<string, ExecInputSource>
): string[] {
  const paths: string[] = [];
  for (const target of collectExecInputValidationTargets(workflow)) {
    if (inlineExecInputSource(target) !== undefined) continue;
    const script = namedScripts.get(target.slot.value);
    if (!script) continue;
    const packaged = parsePackagedResourceReference(target.slot.value);
    const projectOwned =
      packaged !== null
        ? packaged.owner.source === 'project'
        : isPathInside(join(project, '.archon', 'scripts'), script.label);
    if (projectOwned) paths.push(script.label);
  }
  return paths;
}
