import { readFile } from 'fs/promises';
import * as archonPaths from '@archon/paths';
import type { ParsedWorkflowLoadError, WorkflowDefinition } from '../schemas';
import { parsePackagedResourceReference } from '../packaged-workflow';
import { discoverScriptsForCwd } from '../script-discovery';
import {
  collectExecInputValidationTargets,
  inlineExecInputSource,
  validateExecInputTargets,
  type ExecInputSource,
  type ExecInputValidationTarget,
} from '../exec-input-validation';
import type { DiscoveryContext } from './context';
import type { ScopeFile } from './load-dir';

interface NamedScriptTargets {
  workflow: WorkflowDefinition;
  targets: readonly ExecInputValidationTarget[];
}

type ScriptReader = (path: string) => Promise<string>;

/**
 * Validate exec inputs that name a script file against that file's text. A file whose
 * script cannot be found, read, or validated is removed from `files` with its error;
 * validation warnings join the file's parse warnings.
 */
export async function validateNamedScripts(
  context: DiscoveryContext,
  files: Map<string, ScopeFile>,
  errors: ParsedWorkflowLoadError[]
): Promise<void> {
  const targetsByFile = collectNamedScriptTargets(files);
  if (targetsByFile.size === 0) return;

  const discoveryRoot = context.roots.project ?? context.cwd ?? archonPaths.getArchonHome();
  const readScript = cachedScriptReader();
  for (const [filename, entry] of targetsByFile) {
    const outcome = await validateFileScripts(context, discoveryRoot, readScript, entry);
    if ('error' in outcome) {
      errors.push({ filename, ...outcome.error });
      files.delete(filename);
      continue;
    }
    const parsed = files.get(filename);
    if (outcome.warnings.length > 0 && parsed !== undefined) {
      files.set(filename, {
        ...parsed,
        parseWarnings: [...parsed.parseWarnings, ...outcome.warnings],
      });
    }
  }
}

function collectNamedScriptTargets(
  files: ReadonlyMap<string, ScopeFile>
): Map<string, NamedScriptTargets> {
  const targetsByFile = new Map<string, NamedScriptTargets>();
  for (const [filename, { workflow }] of files) {
    const targets = collectExecInputValidationTargets(workflow).filter(
      target => inlineExecInputSource(target) === undefined
    );
    if (targets.length > 0) targetsByFile.set(filename, { workflow, targets });
  }
  return targetsByFile;
}

/** Reads each script once per discovery, replaying a failed read's error. */
function cachedScriptReader(): ScriptReader {
  const contents = new Map<string, string>();
  const readErrors = new Map<string, Error>();
  return async path => {
    const cached = contents.get(path);
    if (cached !== undefined || contents.has(path)) return cached ?? '';
    const priorError = readErrors.get(path);
    if (priorError !== undefined) throw priorError;
    try {
      const content = await readFile(path, 'utf-8');
      contents.set(path, content);
      return content;
    } catch (error) {
      const readError = error instanceof Error ? error : new Error(String(error));
      readErrors.set(path, readError);
      throw readError;
    }
  };
}

interface ScriptsError {
  error: Omit<ParsedWorkflowLoadError, 'filename'>;
}

type FileScriptsOutcome = ScriptsError | { warnings: readonly string[] };

async function validateFileScripts(
  context: DiscoveryContext,
  discoveryRoot: string,
  readScript: ScriptReader,
  { workflow, targets }: NamedScriptTargets
): Promise<FileScriptsOutcome> {
  let scripts: Awaited<ReturnType<typeof discoverScriptsForCwd>>;
  try {
    scripts = await discoverScriptsForCwd(
      discoveryRoot,
      context.roots,
      new Set(targets.map(target => target.slot.value))
    );
  } catch (error) {
    return {
      error: {
        error: `Script discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        workflowName: workflow.name,
        errorType: 'read_error',
        cause: error,
      },
    };
  }
  const sources = await readTargetSources(workflow, targets, scripts, readScript);
  if (!(sources instanceof Map)) return sources;

  const validation = validateExecInputTargets(
    workflow,
    targets,
    target => sources.get(target),
    context.configuredEnvNames
  );
  if (validation.errors.length > 0) {
    return {
      error: {
        workflowName: workflow.name,
        error: validation.errors.join(' '),
        errorType: 'validation_error',
      },
    };
  }
  return { warnings: validation.warnings };
}

async function readTargetSources(
  workflow: WorkflowDefinition,
  targets: readonly ExecInputValidationTarget[],
  scripts: Awaited<ReturnType<typeof discoverScriptsForCwd>>,
  readScript: ScriptReader
): Promise<Map<ExecInputValidationTarget, ExecInputSource> | ScriptsError> {
  const sources = new Map<ExecInputValidationTarget, ExecInputSource>();
  for (const target of targets) {
    const script = scripts.get(target.slot.value);
    if (script === undefined) {
      if (parsePackagedResourceReference(target.slot.value) === null) continue;
      return {
        error: {
          workflowName: workflow.name,
          error: `Named packaged script '${target.slot.value}' was not found in its workflow's scripts directory.`,
          errorType: 'validation_error',
        },
      };
    }
    try {
      sources.set(target, {
        text: await readScript(script.path),
        label: script.path,
        runtime: script.runtime,
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return {
        error: {
          error: `Script file read error at '${script.path}': ${err.message} (${err.code ?? 'unknown'})`,
          workflowName: workflow.name,
          errorType: 'read_error',
          cause: error,
        },
      };
    }
  }
  return sources;
}
