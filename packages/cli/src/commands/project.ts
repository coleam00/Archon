import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectKeyForCodebase } from '@archon/paths';
import { loadConfig } from '@archon/core/config/config-loader';
import { toSafeProjectConfig } from '@archon/core/config';
import type { Codebase } from '@archon/core/schemas/codebase';
import type { IWorkflowHostStore, WorkflowHost } from '@archon/core/workflows/host-store';
import { matchProjectClaim } from '../utils/project-selector';
import { writeJsonLine, writeStderr, writeStdout } from '../utils/stdout';

const USAGE =
  'Usage: archon project list|add [path] [--folder] [--base-branch <name>]|config <id|name> [--json]';

export interface ProjectCommandOptions {
  json?: boolean;
  /** The invocation directory (`--cwd`, else the process cwd); `add` resolves its path against it. */
  cwd: string;
  folder?: boolean;
  baseBranch?: string;
}

/** `archon project <args>`: `list`, `add [path]`, or `config <id|name>`. */
export async function projectCommand(args: string[], opts: ProjectCommandOptions): Promise<number> {
  const { json } = opts;
  const [subcommand, operand] = args;
  const valid =
    (subcommand === 'list' && args.length === 1) ||
    (subcommand === 'add' && args.length <= 2) ||
    (subcommand === 'config' && args.length === 2 && operand);
  if (!valid) return await refuse(USAGE, json);
  if (opts.baseBranch !== undefined && !opts.baseBranch.trim())
    return await refuse('Error: --base-branch requires a nonempty branch name.', json);
  const { createCliWorkflowHost } = await import('../utils/workflow-host');
  const host = await createCliWorkflowHost();
  if (subcommand === 'list') return projectListCommand(host.records.codebases, { json });
  if (subcommand === 'add')
    return projectAddCommand(host, { ...opts, path: resolve(opts.cwd, operand ?? '.') });
  return projectConfigCommand(host.records.codebases, operand, { json });
}

async function refuse(message: string, json?: boolean): Promise<1> {
  if (json) await writeJsonLine({ ok: false, error: message });
  else await writeStderr(`${message}\n`);
  return 1;
}

/**
 * `archon project list`: every registered project, install-wide. `key` is the
 * value `workflow attention --project` and `archon state --project` accept.
 * `workflow run --project` and `project config` accept ID or NAME.
 */
export async function projectListCommand(
  codebases: Pick<IWorkflowHostStore['codebases'], 'listCodebases'>,
  opts: { json?: boolean }
): Promise<number> {
  const projects = (await codebases.listCodebases()).map(withKey);
  if (opts.json) {
    await writeJsonLine({ projects });
    return 0;
  }
  if (projects.length === 0) {
    console.log('No projects registered.');
    return 0;
  }
  console.log('ID\tKIND\tNAME\tKEY\tPATH');
  for (const project of projects) {
    console.log(
      `${project.id}\t${project.kind}\t${project.name}\t${project.key}\t${project.default_cwd}`
    );
  }
  return 0;
}

/** A project row as `project list` and `project add` print it. */
function withKey(codebase: Codebase): Codebase & { key: string } {
  return { ...codebase, key: projectKeyForCodebase(codebase, codebase.default_cwd) };
}

/**
 * `archon project add [path]`: register a project before its first run. It goes
 * through `resolveRunCodebase`, the function a first `workflow run` registers
 * through, so the row, its key and every registration refusal are the same.
 * A repository subdirectory registers the repository root; a directory that is
 * not a git checkout needs `--folder`. A repeat changes nothing and exits 0.
 */
export async function projectAddCommand(
  host: WorkflowHost,
  opts: { path: string; json?: boolean; folder?: boolean; baseBranch?: string }
): Promise<number> {
  if (!existsSync(opts.path))
    return await refuse(`Error: Directory does not exist: ${opts.path}`, opts.json);
  const { resolveRunCodebase } = await import('./workflow-isolation');
  let result: Awaited<ReturnType<typeof resolveRunCodebase>>;
  try {
    result = await resolveRunCodebase(host, opts.path, {
      folder: opts.folder,
      registrationBaseBranch: opts.baseBranch,
    });
  } catch (error) {
    return await refuse(`Error: ${(error as Error).message}`, opts.json);
  }
  if (!result.codebase) {
    return await refuse(
      'Error: Not in a git repository.\n' +
        'Register this directory as a folder project: run archon project add --folder.',
      opts.json
    );
  }
  const project = withKey(result.codebase);
  if (opts.json) {
    await writeJsonLine({ project, registered: result.registered });
    return 0;
  }
  console.log(
    result.registered
      ? `Registered project ${project.name}.`
      : `Project ${project.name} is already registered; nothing changed.`
  );
  console.log(`ID:   ${project.id}`);
  console.log(`Kind: ${project.kind}`);
  console.log(`Key:  ${project.key}`);
  console.log(`Path: ${project.default_cwd}`);
  return 0;
}

/**
 * `archon project config <id|name>`: one registered project's merged config, its
 * own `.archon/config.yaml` included: the view `GET /api/codebases/{id}/config`
 * serves, plus a `project` field naming the match. Env values are never printed,
 * only their keys. Writes no config file, not even a missing global config; like
 * every CLI command it opens the project store, which a fresh install creates.
 */
export async function projectConfigCommand(
  codebases: Pick<IWorkflowHostStore['codebases'], 'listCodebaseClaims' | 'getCodebase'>,
  selector: string,
  opts: { json?: boolean }
): Promise<number> {
  let id: string | undefined;
  try {
    id = matchProjectClaim(await codebases.listCodebaseClaims(), selector)?.id;
  } catch (error) {
    return await refuse(`Error: ${(error as Error).message}`, opts.json);
  }
  const codebase = id ? await codebases.getCodebase(id) : null;
  if (!codebase) {
    return await refuse(
      `Error: Project '${selector}' is not registered. Use archon project list to find one.`,
      opts.json
    );
  }
  const view = {
    project: { id: codebase.id, name: codebase.name },
    ...toSafeProjectConfig(await loadConfig(codebase.default_cwd, { readOnly: true })),
  };
  if (opts.json) await writeJsonLine(view);
  else await writeStdout(`${Bun.YAML.stringify(view, null, 2)}\n`);
  return 0;
}
