/**
 * Connected builder header: project and workflow pickers, New, and the open
 * workflow's Save / Rename / Delete controls.
 */
import type { ReactElement } from 'react';
import type { Project } from '../../primitives/project';

const PICKER_CLASS =
  'max-w-[220px] rounded-[8px] border border-border bg-surface px-2 py-1 font-mono text-[12px] text-text-primary outline-none focus:border-accent-bright/60';

interface PickerProps {
  label: string;
  value: string;
  placeholder: string;
  options: readonly { value: string; label: string }[];
  onPick: (value: string) => void;
}

function Picker({ label, value, placeholder, options, onPick }: PickerProps): ReactElement {
  return (
    <label className="flex items-center gap-2 text-[11.5px] text-text-tertiary">
      {label}
      <select
        value={value}
        onChange={(e): void => {
          onPick(e.target.value);
        }}
        className={PICKER_CLASS}
      >
        <option value="">{placeholder}</option>
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface WorkflowControlsProps {
  dirty: boolean;
  busy: boolean;
  readOnly: boolean;
  isCreateMode: boolean;
  onSave: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/** Save / Rename / Delete for the open workflow, plus the unsaved-changes dot. */
function WorkflowControls({
  dirty,
  busy,
  readOnly,
  isCreateMode,
  onSave,
  onRename,
  onDelete,
}: WorkflowControlsProps): ReactElement {
  const canSave = !busy && (readOnly || dirty || isCreateMode);
  return (
    <div className="flex items-center gap-2">
      {dirty ? (
        <span
          title="Unsaved changes"
          aria-label="Unsaved changes"
          className="h-2 w-2 rounded-full bg-warning"
        />
      ) : null}
      <button
        type="button"
        disabled={!canSave}
        onClick={onSave}
        className="rounded-[8px] bg-accent-bright px-3 py-1 text-[12px] font-semibold text-white/95 transition-opacity hover:brightness-110 disabled:pointer-events-none disabled:opacity-40"
      >
        {readOnly ? 'Save as' : 'Save'}
      </button>
      {!isCreateMode ? (
        <button
          type="button"
          disabled={busy}
          onClick={onRename}
          className="rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-40"
        >
          Rename
        </button>
      ) : null}
      {!readOnly && !isCreateMode ? (
        <button
          type="button"
          disabled={busy}
          onClick={onDelete}
          className="rounded-[8px] px-2.5 py-1 text-[12px] text-error transition-colors hover:bg-error/10 disabled:opacity-40"
        >
          Delete
        </button>
      ) : null}
    </div>
  );
}

export interface BuilderHeaderProps {
  projects: readonly Project[];
  projectId: string | undefined;
  /** The selected project's path; the workflow controls show only once it resolves. */
  cwd: string | undefined;
  name: string | undefined;
  openOptions: readonly string[];
  onPickProject: (id: string) => void;
  onOpenWorkflow: (name: string) => void;
  onNew: () => void;
  /** Present while a workflow is open. */
  controls: WorkflowControlsProps | null;
}

export function BuilderHeader({
  projects,
  projectId,
  cwd,
  name,
  openOptions,
  onPickProject,
  onOpenWorkflow,
  onNew,
  controls,
}: BuilderHeaderProps): ReactElement {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
      <h1 className="text-[14px] font-semibold text-text-primary">Workflow Builder</h1>
      <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
        beta
      </span>

      <Picker
        label="Project"
        value={projectId ?? ''}
        placeholder="Select a project…"
        options={projects.map(p => ({ value: p.id, label: p.name }))}
        onPick={onPickProject}
      />

      {cwd !== undefined ? (
        <Picker
          label="Workflow"
          value={name ?? ''}
          placeholder="Open a workflow…"
          options={openOptions.map(n => ({ value: n, label: n }))}
          onPick={onOpenWorkflow}
        />
      ) : null}

      {cwd !== undefined ? (
        <button
          type="button"
          onClick={onNew}
          className="rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          New
        </button>
      ) : null}

      <div className="flex-1" />

      {controls !== null ? <WorkflowControls {...controls} /> : null}
    </header>
  );
}
