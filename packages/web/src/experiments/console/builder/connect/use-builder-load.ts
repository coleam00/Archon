/**
 * Server reads for the connected builder: the project list, the selected
 * project's workflow list, and the workflow under edit (or the create-mode seed
 * carried in router state instead of a server load).
 */
import { useMemo } from 'react';
import { fromWorkflowDefinition } from '../model';
import type { BuilderWorkflow, Issue } from '../types';
import {
  isInstalledPackWorkflow,
  listWorkflows,
  loadWorkflow,
  type WorkflowLoad,
} from '../../skills/workflows';
import { listProjects, type WorkflowListResult } from '../../skills';
import { useEntity, type EntityView } from '../../store/cache';
import { K } from '../../store/keys';
import { HttpError } from '../../lib/http';
import type { Project } from '../../primitives/project';
import type { Workflow } from '../../primitives/workflow';

/** Router navigation state carried into the connected route. */
export interface BuilderNavState {
  /** A freshly-seeded workflow for create mode (no server load). */
  createSeed?: BuilderWorkflow;
  /** Non-fatal notices to seed the panel after a navigation (e.g. rename delete-failed). */
  notices?: Issue[];
}

const IDLE_LIST_KEY = 'workflows:idle';

export interface ImportedWorkflow {
  workflow: BuilderWorkflow;
  issues: Issue[];
}

export interface BuilderLoad {
  projects: Project[];
  selectedProject: Project | undefined;
  cwd: string | undefined;
  existingNames: string[];
  isCreateMode: boolean;
  /** The workflow under edit: the create-mode seed, else the server load. */
  imported: ImportedWorkflow | null;
  loadedSource: Workflow['source'];
  installedPack: boolean;
  notFound: boolean;
  workflowLoadError: Error | undefined;
  listFetchError: Error | undefined;
}

function createSeedFor(
  navState: BuilderNavState | null,
  name: string | undefined
): BuilderWorkflow | undefined {
  return navState?.createSeed !== undefined && navState.createSeed.name === name
    ? navState.createSeed
    : undefined;
}

/** Workflow list for the open-picker + rename collision checks. */
function useWorkflowList(cwd: string | undefined): EntityView<WorkflowListResult> {
  const listKey = cwd !== undefined ? K.workflows(cwd) : IDLE_LIST_KEY;
  return useEntity<WorkflowListResult>(listKey, () =>
    cwd !== undefined ? listWorkflows(cwd) : Promise.resolve({ workflows: [], recommended: [] })
  );
}

/** Single-workflow load (skipped in create mode — the seed is authoritative). */
function useWorkflowLoad(
  name: string | undefined,
  cwd: string | undefined,
  isCreateMode: boolean
): EntityView<WorkflowLoad | null> {
  const idle = name === undefined || cwd === undefined || isCreateMode;
  const loadKey =
    idle || cwd === undefined || name === undefined ? 'builder:idle' : K.workflow(cwd, name);
  return useEntity<WorkflowLoad | null>(loadKey, () =>
    idle || cwd === undefined || name === undefined
      ? Promise.resolve<WorkflowLoad | null>(null)
      : loadWorkflow(name, cwd)
  );
}

/**
 * Split a genuine 404 (workflow doesn't exist → offer New) from other load
 * failures (500/403/network) — the latter must NOT masquerade as "not found",
 * which would mislead and invite a duplicate via "Create a new workflow".
 */
function classifyLoadError(
  error: Error | undefined
): Pick<BuilderLoad, 'notFound' | 'workflowLoadError'> {
  const notFound = error instanceof HttpError && error.status === 404;
  return { notFound, workflowLoadError: error !== undefined && !notFound ? error : undefined };
}

export function useBuilderLoad(
  name: string | undefined,
  projectId: string | undefined,
  navState: BuilderNavState | null
): BuilderLoad {
  const createSeed = createSeedFor(navState, name);
  const isCreateMode = createSeed !== undefined && name !== undefined;

  const projectsView = useEntity<Project[]>(K.projects, () => listProjects());
  const projects = projectsView.data ?? [];
  const selectedProject = projects.find(p => p.id === projectId);
  const cwd = selectedProject?.path;

  const listView = useWorkflowList(cwd);
  const existingNames = useMemo(
    () => (listView.data?.workflows ?? []).map(w => w.name),
    [listView.data]
  );

  const loadView = useWorkflowLoad(name, cwd, isCreateMode);
  const loaded = loadView.data ?? null;
  const loadedDefinition = loaded !== null && !isInstalledPackWorkflow(loaded) ? loaded : null;

  // Memoized on stable inputs (location-state seed, cache object) so it does NOT
  // produce a fresh identity every render — that would thrash the reset effect.
  const imported = useMemo<ImportedWorkflow | null>(() => {
    if (isCreateMode && createSeed !== undefined) return { workflow: createSeed, issues: [] };
    if (loadedDefinition !== null) return fromWorkflowDefinition(loadedDefinition.definition);
    return null;
  }, [isCreateMode, createSeed, loadedDefinition]);

  return {
    projects,
    selectedProject,
    cwd,
    existingNames,
    isCreateMode,
    imported,
    // Widened to `Workflow['source']` (#2578) so an unrecognised wire value passes
    // through to `effectiveSource` (and the downstream `isReadOnlySource` /
    // `saveTargetFor` helpers) without a cast at this seam.
    loadedSource: isCreateMode ? 'project' : (loadedDefinition?.source ?? 'project'),
    installedPack: loaded !== null && isInstalledPackWorkflow(loaded),
    ...classifyLoadError(name !== undefined && !isCreateMode ? loadView.error : undefined),
    // Surface list-load failures instead of masking them as empty states — a
    // transient backend error otherwise reads as "no projects / no workflows".
    listFetchError: projectsView.error ?? listView.error,
  };
}
