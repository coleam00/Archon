import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { WorkflowBuilder, useBuilderStore } from '@archon/workflow-studio-core';

import { useProject } from '@/contexts/ProjectContext';
import { useWorkflowHydration } from '@/hooks/use-workflow-hydration';
import { clearWorkflowDraft, useWorkflowDraft } from '@/hooks/use-workflow-draft';
import { runSaveFlow } from '@/lib/save-flow';
import { createWebWorkflowApiClient } from '@/lib/web-workflow-api-client';

interface Banner {
  kind: 'success' | 'error';
  message: string;
}

const BANNER_TIMEOUT_MS = 3000;

const MARKETPLACE_URL =
  'https://github.com/coleam00/Archon/blob/main/CONTRIBUTING.md#contributing-workflows-to-the-marketplace';

export function WorkflowBuilderPage(): React.ReactElement {
  const [searchParams] = useSearchParams();
  const editName = searchParams.get('edit');

  const { codebases, selectedProjectId } = useProject();
  const cwd = useMemo<string | undefined>(
    () =>
      selectedProjectId
        ? codebases?.find(cb => cb.id === selectedProjectId)?.default_cwd
        : undefined,
    [codebases, selectedProjectId]
  );

  const client = useMemo(() => createWebWorkflowApiClient(), []);

  const { status, error } = useWorkflowHydration(editName, cwd, client);
  const storeWorkflowName = useBuilderStore(s => s.workflow?.name);

  // Draft autosave: only for new workflows (status === 'not-found'). Restores
  // any saved draft on mount and persists store changes to localStorage so a
  // browser refresh during workflow authoring does not lose the in-flight
  // nodes. Scoping to 'not-found' avoids overwriting a saved workflow with a
  // stale draft when the user edits an existing one.
  useWorkflowDraft(cwd, editName, status === 'not-found');

  const [banner, setBanner] = useState<Banner | null>(null);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleBannerDismiss = useCallback((): void => {
    if (dismissTimeoutRef.current !== null) clearTimeout(dismissTimeoutRef.current);
    dismissTimeoutRef.current = setTimeout(() => {
      dismissTimeoutRef.current = null;
      setBanner(null);
    }, BANNER_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    return (): void => {
      if (dismissTimeoutRef.current !== null) clearTimeout(dismissTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (status === 'loaded' || status === 'idle') {
      // A new hydration succeeded (or we returned to idle) — any banner from a
      // prior workflow's not-found / error / save flow no longer applies.
      setBanner(null);
      return;
    }
    if (status === 'not-found' && editName !== null) {
      setBanner({ kind: 'success', message: `Creating new workflow "${editName}"` });
      scheduleBannerDismiss();
      return;
    }
    if (status === 'error' && error) {
      setBanner({ kind: 'error', message: `Failed to load: ${error.message}` });
    }
  }, [status, editName, error, scheduleBannerDismiss]);

  const onWorkflowNameChange = useCallback((name: string): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const s = useBuilderStore.getState();
    if (s.workflow) {
      s.setWorkflowName(trimmed);
    } else {
      // No meta seeded yet (e.g. user navigated directly to /workflows/builder
      // with no edit param). Seed an empty meta so subsequent saves and
      // setWorkflowName calls have something to mutate.
      // See use-workflow-hydration.ts: parseWorkflow rejects empty
      // description, which would disable Save indefinitely via server-tier
      // validation. Seed a placeholder users can edit later.
      s.loadWorkflow({
        meta: { name: trimmed, description: 'New workflow', base: {}, unknown: {} },
        nodes: [],
      });
    }
  }, []);

  const onSave = useCallback(async (): Promise<void> => {
    if (!cwd) return;
    const s = useBuilderStore.getState();
    if (!s.workflow) {
      setBanner({ kind: 'error', message: 'Workflow name is required' });
      return;
    }

    const result = await runSaveFlow(client, cwd, {
      meta: s.workflow,
      nodes: s.nodes,
    });

    if (result.kind === 'saved') {
      // Drop the localStorage draft for this workflow — the saved server copy
      // is now authoritative, and a leftover draft would shadow it on the
      // next refresh.
      if (cwd) clearWorkflowDraft(cwd, result.name);
      setBanner({ kind: 'success', message: `Saved "${result.name}"` });
      scheduleBannerDismiss();
    } else if (result.kind === 'invalid') {
      setBanner({ kind: 'error', message: result.errors.join('; ') });
    } else {
      setBanner({ kind: 'error', message: `Save failed: ${result.error.message}` });
    }
  }, [client, cwd, scheduleBannerDismiss]);

  const workflowName = storeWorkflowName ?? editName ?? 'untitled';

  if (!cwd) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-text-secondary">
        Select a project to author workflows.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {banner && (
        <div
          role={banner.kind === 'error' ? 'alert' : 'status'}
          className={
            banner.kind === 'error'
              ? 'bg-error/20 text-error px-4 py-2 text-sm'
              : 'bg-success/20 text-success px-4 py-2 text-sm'
          }
        >
          {banner.message}
        </div>
      )}
      <WorkflowBuilder
        client={client}
        archonUrl={window.location.origin}
        cwd={cwd}
        workflowName={workflowName}
        theme="inherit"
        onSave={(): void => {
          void onSave();
        }}
        showValidateButton
        marketplaceUrl={MARKETPLACE_URL}
        onWorkflowNameChange={onWorkflowNameChange}
      />
    </div>
  );
}
