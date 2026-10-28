/**
 * Save, delete, rename and new for the connected builder. Each action reports
 * failures as `Issue[]` in the panel and navigates on success.
 */
import { useCallback } from 'react';
import type { NavigateFunction } from 'react-router';
import { toWorkflowDefinition } from '../model';
import { runValidation } from '../validation';
import { makeIssue } from '../validation/make-issue';
import type {
  BuilderWorkflow,
  BuilderWorkflowDefinition,
  Issue,
  WireWorkflowDefinition,
} from '../types';
import { deleteWorkflow, saveWorkflow, validateWorkflow } from '../../skills/workflows';
import { invalidate } from '../../store/cache';
import { K } from '../../store/keys';
import { errorDetail } from '../../lib/http';
import type { Workflow } from '../../primitives/workflow';
import {
  blockingErrors,
  clientIssue,
  errorToIssues,
  isValidWorkflowName,
  planRename,
  renameReasonMessage,
  saveTargetFor,
  validationFailureToIssues,
} from './save-logic';
import type { BuilderNavState } from './use-builder-load';

export interface BuilderActionsInput {
  name: string | undefined;
  cwd: string | undefined;
  currentWorkflow: BuilderWorkflow | null;
  existingNames: string[];
  effectiveSource: Workflow['source'];
  isCreateMode: boolean;
  /** `?project=<id>` suffix for builder routes. */
  projectQuery: string;
  navigate: NavigateFunction;
  setServerIssues: (issues: Issue[]) => void;
  setDirty: (dirty: boolean) => void;
  setSourceOverride: (source: Workflow['source'] | null) => void;
  setBusy: (busy: boolean) => void;
}

export interface BuilderActions {
  doSave: () => Promise<void>;
  doDelete: () => Promise<void>;
  doRename: () => Promise<void>;
  doNew: () => void;
}

/** The workflow a new-workflow navigation seeds create mode with. */
function newWorkflowSeed(name: string): BuilderWorkflow {
  return {
    name,
    description: 'New workflow.',
    meta: {},
    nodes: [
      {
        id: 'step-1',
        variant: 'prompt',
        base: {},
        data: { prompt: 'Describe what this step should do.' },
      },
    ],
  };
}

function renameDeleteFailed(from: string, to: string, error: unknown): Issue {
  return makeIssue({
    rule: 'rename.delete.failed',
    severity: 'warning',
    source: 'server',
    message: `Renamed to "${to}", but removing the old file "${from}" failed (${errorDetail(error)}). Delete it manually.`,
    path: {},
  });
}

export function useBuilderActions({
  name,
  cwd,
  currentWorkflow,
  existingNames,
  effectiveSource,
  isCreateMode,
  projectQuery,
  navigate,
  setServerIssues,
  setDirty,
  setSourceOverride,
  setBusy,
}: BuilderActionsInput): BuilderActions {
  const doSave = useCallback(async (): Promise<void> => {
    if (currentWorkflow === null || cwd === undefined || name === undefined) return;
    // Force the in-YAML name to match the route name so filename and `name:` stay in sync.
    const draft: BuilderWorkflowDefinition = { ...toWorkflowDefinition(currentWorkflow), name };

    const blocking = blockingErrors(runValidation(currentWorkflow));
    if (blocking.length > 0) {
      setServerIssues([
        clientIssue(
          'save.blocked',
          `Cannot save: fix ${String(blocking.length)} blocking error(s) first.`
        ),
      ]);
      return;
    }

    setBusy(true);
    try {
      const validation = await validateWorkflow(draft);
      if (!validation.valid) {
        setServerIssues(validationFailureToIssues(validation.errors));
        return;
      }
      // The server validated this exact draft against the workflow wire schema.
      const definition = draft as WireWorkflowDefinition;
      const saved = await saveWorkflow(name, definition, {
        cwd,
        source: saveTargetFor(effectiveSource),
      });
      setServerIssues([]);
      setDirty(false);
      setSourceOverride(saved.source);
      invalidate(K.workflows(cwd));
      invalidate(K.workflow(cwd, name));
      // A just-created workflow now exists on disk — drop the create-mode seed
      // from the route so it reloads as a normal project workflow (enabling
      // Rename/Delete). `replace` keeps history clean.
      if (isCreateMode) {
        navigate(`/console/builder/${encodeURIComponent(name)}${projectQuery}`, { replace: true });
      }
    } catch (e) {
      setServerIssues(errorToIssues(e, 'save.failed', 'Save failed (unknown error).'));
    } finally {
      setBusy(false);
    }
  }, [
    currentWorkflow,
    cwd,
    name,
    effectiveSource,
    isCreateMode,
    navigate,
    projectQuery,
    setServerIssues,
    setDirty,
    setSourceOverride,
    setBusy,
  ]);

  const doDelete = useCallback(async (): Promise<void> => {
    if (name === undefined || cwd === undefined) return;
    if (!window.confirm(`Delete workflow "${name}"? This removes the YAML file.`)) return;
    setBusy(true);
    try {
      await deleteWorkflow(name, { cwd, source: saveTargetFor(effectiveSource) });
      invalidate(K.workflows(cwd));
      invalidate(K.workflow(cwd, name));
      navigate(`/console/builder${projectQuery}`);
    } catch (e) {
      setServerIssues(errorToIssues(e, 'delete.failed', 'Delete failed (unknown error).'));
    } finally {
      // The success path navigates away, but this route reuses one component
      // instance across `builder` and `builder/:name`, so clear busy either way.
      setBusy(false);
    }
  }, [name, cwd, effectiveSource, navigate, projectQuery, setServerIssues, setBusy]);

  const doRename = useCallback(async (): Promise<void> => {
    if (name === undefined || cwd === undefined || currentWorkflow === null) return;
    const raw = window.prompt('Rename workflow to:', name);
    if (raw === null) return;
    const to = raw.trim();
    const plan = planRename({ from: name, to, existingNames });
    if (!plan.ok) {
      setServerIssues([clientIssue('rename.blocked', renameReasonMessage(plan.reason, to))]);
      return;
    }

    setBusy(true);
    try {
      const draft: BuilderWorkflowDefinition = {
        ...toWorkflowDefinition(currentWorkflow),
        name: to,
      };
      const validation = await validateWorkflow(draft);
      if (!validation.valid) {
        setServerIssues(validationFailureToIssues(validation.errors));
        return;
      }
      // The server validated this exact draft against the workflow wire schema.
      const definition = draft as WireWorkflowDefinition;
      // New-then-old: the new file is authoritative even if the old delete fails.
      await saveWorkflow(to, definition, { cwd, source: saveTargetFor(effectiveSource) });
      let notices: Issue[] = [];
      try {
        await deleteWorkflow(name, { cwd, source: saveTargetFor(effectiveSource) });
      } catch (delErr) {
        notices = [renameDeleteFailed(name, to, delErr)];
      }
      invalidate(K.workflows(cwd));
      invalidate(K.workflow(cwd, name));
      invalidate(K.workflow(cwd, to));
      setDirty(false);
      navigate(`/console/builder/${encodeURIComponent(to)}${projectQuery}`, {
        state: notices.length > 0 ? ({ notices } satisfies BuilderNavState) : undefined,
      });
    } catch (e) {
      setServerIssues(errorToIssues(e, 'rename.failed', 'Rename failed (unknown error).'));
    } finally {
      setBusy(false);
    }
  }, [
    name,
    cwd,
    currentWorkflow,
    existingNames,
    effectiveSource,
    navigate,
    projectQuery,
    setServerIssues,
    setDirty,
    setBusy,
  ]);

  const doNew = useCallback((): void => {
    if (cwd === undefined) return;
    const raw = window.prompt('New workflow name:', '');
    if (raw === null) return;
    const nm = raw.trim();
    if (!isValidWorkflowName(nm)) {
      setServerIssues([clientIssue('new.invalid-name', renameReasonMessage('invalid-name', nm))]);
      return;
    }
    if (existingNames.includes(nm)) {
      setServerIssues([clientIssue('new.collision', renameReasonMessage('collision', nm))]);
      return;
    }
    navigate(`/console/builder/${encodeURIComponent(nm)}${projectQuery}`, {
      state: { createSeed: newWorkflowSeed(nm) } satisfies BuilderNavState,
    });
  }, [cwd, existingNames, navigate, projectQuery, setServerIssues]);

  return { doSave, doDelete, doRename, doNew };
}
