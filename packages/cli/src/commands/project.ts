import { projectKeyForCodebase } from '@archon/paths';
import { loadConfig } from '@archon/core/config/config-loader';
import { toSafeProjectConfig } from '@archon/core/config';
import type { IWorkflowHostStore } from '@archon/core/workflows/host-store';
import { matchProjectClaim } from '../utils/project-selector';
import { writeJsonLine, writeStderr, writeStdout } from '../utils/stdout';

const USAGE = 'Usage: archon project list|config <id|name> [--json]';

/** `archon project <args>`: `list`, or `config <id|name>`. */
export async function projectCommand(args: string[], json?: boolean): Promise<number> {
  const [subcommand, selector] = args;
  const valid =
    (subcommand === 'list' && args.length === 1) ||
    (subcommand === 'config' && args.length === 2 && selector);
  if (!valid) return await refuse(USAGE, json);
  const { createCliWorkflowHost } = await import('../utils/workflow-host');
  const host = await createCliWorkflowHost();
  if (subcommand === 'list') return projectListCommand(host.records.codebases, { json });
  return projectConfigCommand(host.records.codebases, selector, { json });
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
  const projects = (await codebases.listCodebases()).map(codebase => ({
    ...codebase,
    key: projectKeyForCodebase(codebase, codebase.default_cwd),
  }));
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
