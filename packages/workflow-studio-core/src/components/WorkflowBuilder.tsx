import { ReactFlowProvider } from '@xyflow/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { ApiClientProvider } from '../api/ApiClientProvider';
import { ThemeProvider, type ThemePreset } from '../theme/ThemeProvider';
import type { WorkflowApiClient } from '../api/WorkflowApiClient';
import { useBuilderStore } from '../store/builder-store';
import { usePositionPersistence } from '../hooks/usePositionPersistence';
import { PositionProvider } from '../hooks/PositionContext';
import { Canvas } from './Canvas';
import { NodeLibrary } from './NodeLibrary';
import { NodeInspector } from './inspector/NodeInspector';
import { Toolbar } from './Toolbar';
import { YamlPreviewDrawer } from './preview/YamlPreviewDrawer';
import { StudioErrorBoundary } from './StudioErrorBoundary';
import { ValidationPanel } from './ValidationPanel';
import { useValidation } from '../validation/useValidation';
import { SHORTCUTS } from '../shortcuts';
import styles from './WorkflowBuilder.module.css';

export interface WorkflowBuilderProps {
  client: WorkflowApiClient;
  /** Optional theme preset override. When omitted, the value from useThemeStore is used. */
  theme?: ThemePreset;
  /** Used to key persisted positions. In dev/standalone Phase 2, pass `__dev__`. */
  archonUrl: string;
  cwd: string;
  /** The current workflow's name — also used for position keying. */
  workflowName: string;
  /**
   * Called when the user clicks the Save button. When omitted, the Save button
   * is not rendered (caller opts in explicitly). The button is disabled when
   * there are active validation errors.
   */
  onSave?: () => void;
  /** When false, hides the theme picker in the toolbar. Defaults to true. */
  showThemePicker?: boolean;
  /**
   * When true, a "Validate" button appears in the toolbar that force-refreshes
   * validation. The button's loading state is driven by the same internal
   * useValidation hook, so the caller doesn't pass anything beyond this flag.
   */
  showValidateButton?: boolean;
  /** When provided, a "Share to Marketplace" trailing link appears in the toolbar. */
  marketplaceUrl?: string;
}

/**
 * Inner component — rendered inside all providers (ApiClientProvider, ThemeProvider, etc.)
 * so hooks like useValidation() (which calls useWorkflowApi()) are safe to call here.
 */
function WorkflowBuilderInner({
  cwd,
  workflowName,
  positions,
  onSave,
  showThemePicker,
  showValidateButton,
  marketplaceUrl,
}: {
  cwd: string;
  workflowName: string;
  positions: ReturnType<typeof usePositionPersistence>;
  onSave?: () => void;
  showThemePicker?: boolean;
  showValidateButton?: boolean;
  marketplaceUrl?: string;
}): JSX.Element {
  const storeName = useBuilderStore(s => s.workflow?.name ?? workflowName);
  const isYamlOpen = useBuilderStore(s => s.isYamlPreviewOpen);
  const setYamlOpen = useBuilderStore(s => s.setYamlPreviewOpen);
  const [drawerExpanded, setDrawerExpanded] = useState(false);
  const { issues, isValidating, focusIssue, revalidate } = useValidation();

  const copySelection = useBuilderStore(s => s.copySelection);
  const pasteClipboard = useBuilderStore(s => s.pasteClipboard);
  const cutSelection = useBuilderStore(s => s.cutSelection);
  const removeSelected = useBuilderStore(s => s.removeSelected);
  const selectAll = useBuilderStore(s => s.selectAll);
  const clearSelection = useBuilderStore(s => s.clearSelection);
  const alignSelection = useBuilderStore(s => s.alignSelection);
  const autoArrangeSelection = useBuilderStore(s => s.autoArrangeSelection);
  const toggleGridSnap = useBuilderStore(s => s.toggleGridSnap);
  const applyUndo = useBuilderStore(s => s.applyUndo);
  const applyRedo = useBuilderStore(s => s.applyRedo);

  const hotkeyOptions = { enableOnFormTags: false, enableOnContentEditable: false } as const;

  useHotkeys(
    SHORTCUTS.copy,
    e => {
      e.preventDefault();
      void copySelection();
    },
    hotkeyOptions
  );
  useHotkeys(
    SHORTCUTS.paste,
    e => {
      e.preventDefault();
      void pasteClipboard().then(() => {
        positions.setMany(Object.entries(useBuilderStore.getState().positions));
      });
    },
    hotkeyOptions
  );
  useHotkeys(
    SHORTCUTS.cut,
    e => {
      e.preventDefault();
      void cutSelection();
    },
    hotkeyOptions
  );
  useHotkeys(
    SHORTCUTS.selectAll,
    e => {
      e.preventDefault();
      selectAll();
    },
    hotkeyOptions
  );
  useHotkeys(
    SHORTCUTS.clearSelection,
    () => {
      clearSelection();
    },
    hotkeyOptions
  );
  useHotkeys(
    SHORTCUTS.delete as unknown as string[],
    e => {
      e.preventDefault();
      removeSelected();
    },
    hotkeyOptions
  );
  useHotkeys(
    SHORTCUTS.alignLeft,
    e => {
      e.preventDefault();
      useBuilderStore.getState().setManyPositions(positions.positions);
      alignSelection('left');
      positions.setMany(Object.entries(useBuilderStore.getState().positions));
    },
    hotkeyOptions
  );
  useHotkeys(
    SHORTCUTS.alignRight,
    e => {
      e.preventDefault();
      useBuilderStore.getState().setManyPositions(positions.positions);
      alignSelection('right');
      positions.setMany(Object.entries(useBuilderStore.getState().positions));
    },
    hotkeyOptions
  );
  useHotkeys(
    SHORTCUTS.alignTop,
    e => {
      e.preventDefault();
      useBuilderStore.getState().setManyPositions(positions.positions);
      alignSelection('top');
      positions.setMany(Object.entries(useBuilderStore.getState().positions));
    },
    hotkeyOptions
  );
  useHotkeys(
    SHORTCUTS.alignBottom,
    e => {
      e.preventDefault();
      useBuilderStore.getState().setManyPositions(positions.positions);
      alignSelection('bottom');
      positions.setMany(Object.entries(useBuilderStore.getState().positions));
    },
    hotkeyOptions
  );
  useHotkeys(
    SHORTCUTS.autoArrangeSelection,
    e => {
      e.preventDefault();
      useBuilderStore.getState().setManyPositions(positions.positions);
      autoArrangeSelection();
      positions.setMany(Object.entries(useBuilderStore.getState().positions));
    },
    hotkeyOptions
  );
  useHotkeys(
    SHORTCUTS.toggleGridSnap,
    e => {
      e.preventDefault();
      toggleGridSnap();
    },
    hotkeyOptions
  );
  useHotkeys(
    SHORTCUTS.undo,
    e => {
      e.preventDefault();
      useBuilderStore.getState().setManyPositions(positions.positions);
      applyUndo();
      positions.setMany(Object.entries(useBuilderStore.getState().positions));
    },
    hotkeyOptions
  );
  useHotkeys(
    SHORTCUTS.redo,
    e => {
      e.preventDefault();
      useBuilderStore.getState().setManyPositions(positions.positions);
      applyRedo();
      positions.setMany(Object.entries(useBuilderStore.getState().positions));
    },
    hotkeyOptions
  );

  const hasErrors = useMemo(() => issues.some(i => i.severity === 'error'), [issues]);
  const topErrors = useMemo(
    () =>
      issues
        .filter(i => i.severity === 'error')
        .slice(0, 3)
        .map(i => i.message),
    [issues]
  );

  return (
    <div className={styles.shell} data-drawer={drawerExpanded ? 'expanded' : 'collapsed'}>
      <div className={styles.toolbar}>
        <Toolbar
          workflowName={storeName}
          onResetLayout={positions.reset}
          onSave={onSave}
          hasErrors={hasErrors}
          topErrors={topErrors}
          isYamlPreviewOpen={isYamlOpen}
          onToggleYamlPreview={() => {
            setYamlOpen(!isYamlOpen);
          }}
          showThemePicker={showThemePicker}
          onValidate={showValidateButton ? revalidate : undefined}
          isValidating={showValidateButton ? isValidating : undefined}
          marketplaceUrl={marketplaceUrl}
        />
      </div>
      <div className={styles.library}>
        <NodeLibrary cwd={cwd} />
      </div>
      <main className={styles.canvas}>
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
      </main>
      <div className={styles.inspector} data-pane={isYamlOpen ? 'yaml-preview' : 'inspector'}>
        {isYamlOpen ? <YamlPreviewDrawer /> : <NodeInspector />}
      </div>
      <section className={styles.drawer} data-testid="validation-drawer">
        <ValidationPanel
          issues={issues}
          expanded={drawerExpanded}
          onToggle={setDrawerExpanded}
          onFocusIssue={focusIssue}
          isValidating={isValidating}
        />
      </section>
    </div>
  );
}

export function WorkflowBuilder({
  client,
  theme,
  archonUrl,
  cwd,
  workflowName,
  onSave,
  showThemePicker,
  showValidateButton,
  marketplaceUrl,
}: WorkflowBuilderProps): JSX.Element {
  const queryClient = useMemo(() => new QueryClient(), []);
  const positions = usePositionPersistence(archonUrl, cwd, workflowName);

  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={client}>
        <ThemeProvider preset={theme}>
          <StudioErrorBoundary>
            <PositionProvider value={positions}>
              <WorkflowBuilderInner
                cwd={cwd}
                workflowName={workflowName}
                positions={positions}
                onSave={onSave}
                showThemePicker={showThemePicker}
                showValidateButton={showValidateButton}
                marketplaceUrl={marketplaceUrl}
              />
            </PositionProvider>
          </StudioErrorBoundary>
        </ThemeProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
}
