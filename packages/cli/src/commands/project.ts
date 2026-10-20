import { projectKeyForCodebase } from '@archon/paths';
import type { IWorkflowHostStore } from '@archon/core/workflows/host-store';
import { writeJsonLine, writeStderr } from '../utils/stdout';

/** `archon project <args>`; `list` is the only subcommand. */
export async function projectCommand(args: string[], json?: boolean): Promise<number> {
  if (args.length !== 1 || args[0] !== 'list') {
    const usage = 'Usage: archon project list [--json]';
    if (json) await writeJsonLine({ ok: false, error: usage });
    else await writeStderr(`${usage}\n`);
    return 1;
  }
  const { createCliWorkflowHost } = await import('../utils/workflow-host');
  const host = await createCliWorkflowHost();
  return projectListCommand(host.records.codebases, { json });
}

/**
 * `archon project list`: every registered project, install-wide. `key` is the
 * value `workflow attention --project` and `archon state --project` accept.
 * `workflow run --project` accepts ID or NAME.
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
