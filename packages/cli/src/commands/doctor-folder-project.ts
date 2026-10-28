import { canonicalizeProjectPath } from '@archon/paths';
import type { Codebase } from '@archon/core';
import { doctorLog, type CheckResult } from './doctor-check';

type FolderCodebase = Pick<Codebase, 'name' | 'default_cwd' | 'kind'>;

export interface FolderProjectDeps {
  findCodebaseByDefaultCwd: (cwd: string) => Promise<FolderCodebase | null>;
  findCodebaseByPathPrefix: (cwd: string) => Promise<FolderCodebase | null>;
  listChildRepos: (rootPath: string) => Promise<string[]>;
}

async function loadFolderProjectDeps(): Promise<FolderProjectDeps> {
  const codebaseDb = await import('@archon/core/db/codebases');
  const { listChildRepos } = await import('@archon/git');
  return {
    findCodebaseByDefaultCwd: codebaseDb.findCodebaseByDefaultCwd,
    findCodebaseByPathPrefix: codebaseDb.findCodebaseByPathPrefix,
    listChildRepos,
  };
}

/**
 * When the current directory is a registered folder project, report it and list
 * the git repos contained under its root. Skips quietly (not a failure) for a
 * normal git-repo cwd, an unregistered directory, or when the DB is unavailable.
 */
export async function checkFolderProject(
  cwd: string = process.cwd(),
  loadDeps: () => Promise<FolderProjectDeps> = loadFolderProjectDeps
): Promise<CheckResult> {
  const label = 'Folder project';
  let deps: FolderProjectDeps;
  try {
    deps = await loadDeps();
  } catch (err) {
    doctorLog().debug({ err }, 'doctor.folder_project_module_load_failed');
    return { label, status: 'skip', message: 'unavailable (module load failed)' };
  }
  // Same canonicalizer as the CLI gate and as registration, so doctor reports
  // the project the rest of the CLI will actually resolve here — a raw cwd
  // misses a symlinked or Windows short-name root that is registered (#2927).
  const canonicalCwd = await canonicalizeProjectPath(cwd);
  let codebase: FolderCodebase | null;
  try {
    codebase =
      (await deps.findCodebaseByDefaultCwd(canonicalCwd)) ??
      (await deps.findCodebaseByPathPrefix(canonicalCwd));
  } catch (err) {
    doctorLog().debug({ err, cwd: canonicalCwd }, 'doctor.folder_project_lookup_failed');
    return { label, status: 'skip', message: 'could not check (database unavailable)' };
  }
  if (codebase?.kind !== 'folder') {
    return { label, status: 'skip', message: 'cwd is not a registered folder project' };
  }
  const childRepos = await deps.listChildRepos(codebase.default_cwd);
  const shown = childRepos.slice(0, 10);
  const remaining = childRepos.length - shown.length;
  let reposMsg: string;
  if (childRepos.length === 0) {
    reposMsg = 'no contained git repos';
  } else {
    const moreSuffix = remaining > 0 ? `, … (+${String(remaining)} more)` : '';
    reposMsg = `${String(childRepos.length)} contained repo(s): ${shown.join(', ')}${moreSuffix}`;
  }
  return {
    label,
    status: 'pass',
    message: `"${codebase.name}" (runs in place) — ${reposMsg}`,
  };
}
