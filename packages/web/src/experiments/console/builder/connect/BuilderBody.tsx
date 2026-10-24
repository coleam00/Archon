/**
 * The connected builder's main area: the editor for an open workflow, or the
 * state that explains why none is open (no project, load failure, not found,
 * nothing picked, installed pack, loading).
 */
import type { ReactElement, ReactNode } from 'react';
import { BuilderPage } from '../BuilderPage';
import type { BuilderWorkflow, Issue } from '../types';
import { errorDetail } from '../../lib/http';
import type { Project } from '../../primitives/project';
import type { ImportResult } from '../model';

const SECONDARY_BUTTON_CLASS =
  'mt-3 rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary';

function EmptyState({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-[12.5px] text-text-tertiary">
      <div className="max-w-md">{children}</div>
    </div>
  );
}

function LoadFailed({ name, error }: { name: string | undefined; error: Error }): ReactElement {
  return (
    <EmptyState>
      <p>
        Failed to load <span className="font-mono">{name}</span>: {errorDetail(error)}
      </p>
      <p className="mt-2">The workflow may still exist — retry once the server is reachable.</p>
    </EmptyState>
  );
}

function NotFound({
  name,
  projectName,
  onNew,
}: {
  name: string | undefined;
  projectName: string;
  onNew: () => void;
}): ReactElement {
  return (
    <EmptyState>
      <p>
        No workflow named <span className="font-mono">{name}</span> was found in{' '}
        <span className="font-mono">{projectName}</span>.
      </p>
      <p className="mt-2">
        It may live in a subfolder (not loadable via the single-name route) or not exist yet.
      </p>
      <button type="button" onClick={onNew} className={SECONDARY_BUTTON_CLASS}>
        Create a new workflow
      </button>
    </EmptyState>
  );
}

function NoWorkflowPicked({
  projectName,
  hasWorkflows,
  onCreateFirst,
}: {
  projectName: string;
  hasWorkflows: boolean;
  onCreateFirst: () => void;
}): ReactElement {
  if (hasWorkflows) {
    return (
      <EmptyState>
        Pick a workflow from the <span className="font-semibold">Workflow</span> menu above to start
        editing, or create a new one.
      </EmptyState>
    );
  }
  return (
    <EmptyState>
      <p>
        <span className="font-mono">{projectName}</span> has no project workflows yet.
      </p>
      <button type="button" onClick={onCreateFirst} className={SECONDARY_BUTTON_CLASS}>
        Create the first workflow
      </button>
    </EmptyState>
  );
}

function InstalledPackNotice({ name }: { name: string }): ReactElement {
  return (
    <EmptyState>
      <p>
        <span className="font-mono">{name}</span> is installed from a pack — read-only.
      </p>
      <p className="mt-2">
        The builder cannot edit it. Update the pack with{' '}
        <span className="font-mono">archon plugin update</span>, or make an editable project copy
        with <span className="font-mono">archon plugin copy</span>.
      </p>
    </EmptyState>
  );
}

export interface BuilderBodyProps {
  selectedProject: Project | undefined;
  name: string | undefined;
  workflowLoadError: Error | undefined;
  notFound: boolean;
  installedPack: boolean;
  existingNames: readonly string[];
  imported: ImportResult | null;
  currentWorkflow: BuilderWorkflow | null;
  editorKey: string;
  extraIssues: Issue[];
  onChange: (bw: BuilderWorkflow) => void;
  /** New behind the unsaved-changes guard. */
  onNew: () => void;
  /** New without the guard: nothing is open to lose. */
  onCreateFirst: () => void;
}

export function BuilderBody(props: BuilderBodyProps): ReactElement {
  const { selectedProject, name, imported } = props;
  if (selectedProject === undefined) {
    return (
      <EmptyState>
        Select a project to load its workflows. Workflows are discovered and saved per project (the
        project's <span className="font-mono">cwd</span>).
      </EmptyState>
    );
  }
  if (props.workflowLoadError !== undefined) {
    return <LoadFailed name={name} error={props.workflowLoadError} />;
  }
  if (props.notFound) {
    return <NotFound name={name} projectName={selectedProject.name} onNew={props.onNew} />;
  }
  if (name === undefined) {
    return (
      <NoWorkflowPicked
        projectName={selectedProject.name}
        hasWorkflows={props.existingNames.length > 0}
        onCreateFirst={props.onCreateFirst}
      />
    );
  }
  if (props.installedPack) return <InstalledPackNotice name={name} />;
  if (imported !== null && props.currentWorkflow !== null) {
    return (
      <BuilderPage
        key={props.editorKey}
        initialWorkflow={imported.workflow}
        onChange={props.onChange}
        extraIssues={props.extraIssues}
      />
    );
  }
  return <EmptyState>Loading workflow…</EmptyState>;
}
