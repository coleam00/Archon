/**
 * Connected workflow builder route (PR-3). Replaces the fixture-backed
 * `BuilderRoute`: it resolves a `:name` param + the selected project (`cwd`),
 * loads a real workflow via the `loadWorkflow` skill verb, renders the
 * controlled `BuilderPage`, and persists edits through `saveWorkflow` with full
 * create / rename / delete. Bundled workflows open read-only and Save-as writes
 * a project override. An installed-pack workflow has no authored form to edit, so
 * it gets a read-only notice instead of the editor.
 *
 * Nav guard: the app is a non-data `<BrowserRouter>`, so `useBlocker` is
 * unavailable. We use `beforeunload` (reload/close) plus a
 * `confirmIfDirty` wrapper around this header's OWN navigation controls. The
 * browser Back button and `ProjectRail` clicks are NOT intercepted — a known
 * limitation; a data-router migration is out of scope for PR-3.
 *
 * House rules: no `console.*`; all failures surface as `Issue[]` in the panel.
 */
import { useCallback, useMemo, type ReactElement } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router';
import { useBuilderProject, useProjectSearchParam } from './connect/use-builder-project';
import { useBuilderLoad, type BuilderNavState } from './connect/use-builder-load';
import { useBuilderEditor } from './connect/use-builder-editor';
import { useBuilderActions } from './connect/use-builder-actions';
import { BuilderHeader } from './connect/BuilderHeader';
import { BuilderBody } from './connect/BuilderBody';

export function BuilderConnected(): ReactElement {
  const { name } = useParams<{ name?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId, setProjectId } = useBuilderProject();
  useProjectSearchParam(projectId);

  const navState = location.state as BuilderNavState | null;
  const load = useBuilderLoad(name, projectId, navState);
  const { cwd, existingNames, isCreateMode, imported } = load;

  const editorKey = `${cwd ?? ''}:${name ?? ''}:${String(isCreateMode)}`;
  const editor = useBuilderEditor({
    imported,
    editorKey,
    isCreateMode,
    loadedSource: load.loadedSource,
    notices: navState?.notices,
  });
  const { confirmIfDirty, readOnly } = editor;

  const projectQuery = `?project=${encodeURIComponent(projectId ?? '')}`;
  const { doSave, doDelete, doRename, doNew } = useBuilderActions({
    name,
    cwd,
    currentWorkflow: editor.currentWorkflow,
    existingNames,
    effectiveSource: editor.effectiveSource,
    isCreateMode,
    projectQuery,
    navigate,
    setServerIssues: editor.setServerIssues,
    setDirty: editor.setDirty,
    setSourceOverride: editor.setSourceOverride,
    setBusy: editor.setBusy,
  });

  // --- Navigation controls (dirty-guarded) ---------------------------------
  const onPickProject = useCallback(
    (id: string): void => {
      confirmIfDirty(() => {
        // The "Select a project…" option has value ""; normalize it to the
        // hook's no-selection contract (`undefined`) and omit `?project=`.
        const next = id === '' ? undefined : id;
        setProjectId(next);
        navigate(
          next === undefined
            ? '/console/builder'
            : `/console/builder?project=${encodeURIComponent(next)}`
        );
      });
    },
    [confirmIfDirty, setProjectId, navigate]
  );

  const onOpenWorkflow = useCallback(
    (wf: string): void => {
      if (wf === '' || wf === name) return;
      confirmIfDirty(() => {
        navigate(`/console/builder/${encodeURIComponent(wf)}${projectQuery}`);
      });
    },
    [confirmIfDirty, navigate, projectQuery, name]
  );

  const onNew = useCallback((): void => {
    confirmIfDirty(doNew);
  }, [confirmIfDirty, doNew]);

  // Ensure the currently-open name is selectable even when it isn't in the list
  // yet — e.g. a create-mode name (no file on disk), or before the list fetch
  // resolves. Dedupe.
  const openOptions = useMemo(() => {
    const names = new Set(existingNames);
    if (name !== undefined) names.add(name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [existingNames, name]);

  const workflowOpen = name !== undefined && imported !== null;
  const { listFetchError } = load;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BuilderHeader
        projects={load.projects}
        projectId={projectId}
        cwd={cwd}
        name={name}
        openOptions={openOptions}
        onPickProject={onPickProject}
        onOpenWorkflow={onOpenWorkflow}
        onNew={onNew}
        controls={
          workflowOpen
            ? {
                dirty: editor.dirty,
                busy: editor.busy,
                readOnly,
                isCreateMode,
                onSave: (): void => {
                  void doSave();
                },
                onRename: (): void => {
                  void doRename();
                },
                onDelete: (): void => {
                  void doDelete();
                },
              }
            : null
        }
      />

      {listFetchError !== undefined ? (
        <div
          title={listFetchError.message}
          className="border-b border-error/30 bg-error/10 px-4 py-1.5 font-mono text-[11px] text-error"
        >
          Failed to load: {listFetchError.message}
        </div>
      ) : null}

      {workflowOpen && readOnly ? (
        <div className="border-b border-border bg-warning/10 px-4 py-1.5 text-[11.5px] text-text-secondary">
          Bundled workflow — read-only. <span className="font-semibold">Save as</span> writes a
          project override that shadows the bundled default.
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <BuilderBody
          selectedProject={load.selectedProject}
          name={name}
          workflowLoadError={load.workflowLoadError}
          notFound={load.notFound}
          installedPack={load.installedPack}
          existingNames={existingNames}
          imported={imported}
          currentWorkflow={editor.currentWorkflow}
          editorKey={editorKey}
          extraIssues={editor.extraIssues}
          onChange={editor.handleChange}
          onNew={onNew}
          onCreateFirst={doNew}
        />
      </div>
    </div>
  );
}
