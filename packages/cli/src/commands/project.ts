import { projectKeyForCodebase } from '@archon/paths';
import type { IWorkflowHostStore } from '@archon/core/workflows/host-store';
import { writeJsonLine } from '../utils/stdout';

/**
 * `archon project list`: every registered project, install-wide. `key` is the
 * value `--project` and `archon state --project` accept.
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
