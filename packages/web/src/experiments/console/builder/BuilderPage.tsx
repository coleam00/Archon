/**
 * The visual workflow builder, assembled. A **controlled surface**: it takes
 * its workflow as a prop and reports edits through `onChange` — no skill
 * calls, no route params, no `store/cache.ts`. PR-3 wraps this component with
 * `loadWorkflow`/`saveWorkflow` skill verbs and the live `:name` route; that
 * seam is what keeps PR-2 independently reviewable and revertable.
 *
 * Editor state (workflow + positions + selection + history + clipboard) lives
 * in `editor/state.ts`'s reducer; this file wires the canvas, palette,
 * inspector, validation panel, YAML preview, toolbar, and keymap together.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { ReactFlowInstance } from '@xyflow/react';
import { useKeymap } from '../lib/keymap';
import { KeymapHelp } from '../components/KeymapHelp';
import type { BuilderWorkflow, Issue, VariantId } from './types';
import { runValidation } from './validation';
import { toWorkflowDefinition } from './model';
import { serializeToYaml } from './yaml';
import { builderToFlow } from './flow';
import type { BuilderFlowEdge, BuilderFlowNode, XYPosition } from './flow/types';
import {
  canRedo,
  canUndo,
  createEditorState,
  editorReducer,
  type EditorAction,
  type NodeSize,
} from './editor/state';
import { buildBuilderBindings, builderKeymapGroups } from './editor/keymap';
import type { AlignMode } from './editor/align';
import { BuilderCanvas } from './components/BuilderCanvas';
import { NodePalette } from './components/NodePalette';
import { Inspector } from './components/Inspector';
import { IssueList } from './components/IssueList';
import { YamlPreview } from './components/YamlPreview';
import { Toolbar } from './components/Toolbar';

interface BuilderPageProps {
  initialWorkflow: BuilderWorkflow;
  onChange?: (bw: BuilderWorkflow) => void;
  /**
   * Issues produced outside the client validation tiers — import issues from the
   * round-trip and server-tier validation/save errors (PR-3). Merged into the
   * panel alongside the debounced `runValidation` output and deduped by id, so a
   * re-validation never clobbers a server/import issue.
   */
  extraIssues?: Issue[];
}

const VALIDATION_DEBOUNCE_MS = 300;

/** Distributive omit of `at` across the timestamped action union. */
type UnstampedAction = EditorAction extends infer A
  ? A extends { at: number }
    ? Omit<A, 'at'>
    : never
  : never;

export function BuilderPage({
  initialWorkflow,
  onChange,
  extraIssues,
}: BuilderPageProps): ReactElement {
  const [state, dispatch] = useReducer(editorReducer, initialWorkflow, createEditorState);
  const [issues, setIssues] = useState<Issue[]>(() => runValidation(initialWorkflow));
  const [helpOpen, setHelpOpen] = useState(false);
  const [rightTab, setRightTab] = useState<'inspect' | 'yaml'>('inspect');
  const flowRef = useRef<ReactFlowInstance<BuilderFlowNode, BuilderFlowEdge> | null>(null);

  /** Stamp mutating actions with the wall clock for history coalescing. */
  const stamped = useCallback((action: UnstampedAction): void => {
    dispatch({ ...action, at: Date.now() } as EditorAction);
  }, []);

  // Re-validate on a debounce after edits (PR-1 client tiers only).
  useEffect(() => {
    const timer = setTimeout(() => {
      setIssues(runValidation(state.workflow));
    }, VALIDATION_DEBOUNCE_MS);
    return (): void => {
      clearTimeout(timer);
    };
  }, [state.workflow]);

  // Report workflow edits (not position/selection churn) to the wrapper.
  // Compare against the last-reported value instead of a fired-once flag:
  // StrictMode double-invokes effects with refs preserved, so a skip-once
  // guard would fire a spurious onChange(initialWorkflow) on the re-run.
  const lastReported = useRef(initialWorkflow);
  useEffect(() => {
    if (state.workflow === lastReported.current) return;
    lastReported.current = state.workflow;
    onChange?.(state.workflow);
  }, [state.workflow, onChange]);

  const { nodes, edges } = useMemo(() => {
    const derived = builderToFlow(state.workflow, state.positions, state.selectedNodes);
    return {
      nodes: derived.nodes,
      // Override the edge's inline stroke when selected: xyflow's `.selected`
      // CSS can't win against an inline `style.stroke`, so a selected edge would
      // otherwise look identical to an unselected one. Spreading `e.style` keeps
      // a conditional edge's dashes while swapping in the accent stroke.
      edges: derived.edges.map(e =>
        state.selectedEdges.has(e.id)
          ? {
              ...e,
              selected: true,
              style: { ...e.style, stroke: 'var(--accent)', strokeWidth: 2 },
            }
          : e
      ),
    };
  }, [state.workflow, state.positions, state.selectedNodes, state.selectedEdges]);

  const yamlText = useMemo(
    () => serializeToYaml(toWorkflowDefinition(state.workflow)),
    [state.workflow]
  );

  // Merge client-tier issues with import/server issues (`extraIssues`), deduped
  // by stable id. Kept separate in state so the debounced client re-validation
  // (which calls setIssues) can never clobber a persisted server/import issue.
  const mergedIssues = useMemo(() => {
    const byId = new Map<string, Issue>();
    for (const issue of issues) byId.set(issue.id, issue);
    for (const issue of extraIssues ?? []) byId.set(issue.id, issue);
    return [...byId.values()];
  }, [issues, extraIssues]);

  const selectedNode =
    state.selectedNodes.size === 1
      ? (state.workflow.nodes.find(n => state.selectedNodes.has(n.id)) ?? null)
      : null;

  // Selection is driven by per-element deltas from the canvas (xyflow's only
  // selection channel in controlled mode); the reducer merges them and the
  // `apply-selection` no-op guard prevents render churn. No stale-state deps,
  // so this callback is stable.
  const handleSelectDelta = useCallback(
    (
      selectedNodes: readonly { id: string; selected: boolean }[],
      selectedEdges: readonly { id: string; selected: boolean }[]
    ): void => {
      dispatch({ type: 'apply-selection', nodes: selectedNodes, edges: selectedEdges });
    },
    []
  );

  const handleMoveNodes = useCallback(
    (moves: readonly { id: string; position: XYPosition }[]): void => {
      stamped({ type: 'move-nodes', moves });
    },
    [stamped]
  );

  const handleConnect = useCallback(
    (source: string, target: string): void => {
      stamped({ type: 'add-edge', source, target });
    },
    [stamped]
  );

  const handleAddNode = useCallback(
    (variant: VariantId, position: XYPosition): void => {
      stamped({ type: 'add-node', variant, position });
    },
    [stamped]
  );

  // Palette click (no drag): stagger new nodes from a fixed corner.
  const handlePaletteAdd = useCallback(
    (variant: VariantId): void => {
      const n = state.workflow.nodes.length;
      stamped({ type: 'add-node', variant, position: { x: 60 + (n % 5) * 36, y: 60 + n * 28 } });
    },
    [stamped, state.workflow.nodes.length]
  );

  // The reducer reads the selection itself, so this callback (and therefore
  // the keymap bindings below) stays referentially stable across selection
  // changes — re-creating bindings would make useKeymap re-register and wipe
  // an in-progress chord buffer.
  const removeSelection = useCallback((): void => {
    stamped({ type: 'remove-selection' });
  }, [stamped]);

  const fitView = useCallback((): void => {
    void flowRef.current?.fitView({ padding: 0.2, duration: 200 });
  }, []);

  // Context-menu callbacks (stable refs; the reducer reads selection/clipboard
  // itself). `set-selection` replaces the whole selection so a right-click can
  // target the clicked element; duplicate is copy-then-paste in one tick (the
  // reducer applies the two dispatches sequentially, so paste sees the clipboard
  // the copy just wrote).
  const handleSetSelection = useCallback(
    (nodeIds: readonly string[], edgeIds: readonly string[]): void => {
      dispatch({ type: 'set-selection', nodeIds: new Set(nodeIds), edgeIds: new Set(edgeIds) });
    },
    []
  );
  const handleCopy = useCallback((): void => {
    dispatch({ type: 'copy' });
  }, []);
  const handleCut = useCallback((): void => {
    stamped({ type: 'cut' });
  }, [stamped]);
  const handlePaste = useCallback((): void => {
    stamped({ type: 'paste' });
  }, [stamped]);
  const handleDuplicate = useCallback((): void => {
    dispatch({ type: 'copy' });
    stamped({ type: 'paste' });
  }, [stamped]);
  const handleSelectAll = useCallback((): void => {
    dispatch({ type: 'select-all' });
  }, []);
  const handleAutoArrange = useCallback((): void => {
    stamped({ type: 'auto-arrange' });
  }, [stamped]);

  /** Measured node sizes from the live canvas, so align/distribute use the
   *  same geometry as smart-guide snapping (constants are the fallback). */
  const measuredSizes = useCallback((): ReadonlyMap<string, NodeSize> => {
    const sizes = new Map<string, NodeSize>();
    for (const node of flowRef.current?.getNodes() ?? []) {
      if (node.measured?.width !== undefined && node.measured.height !== undefined) {
        sizes.set(node.id, { width: node.measured.width, height: node.measured.height });
      }
    }
    return sizes;
  }, []);

  const alignSelection = useCallback(
    (mode: AlignMode): void => {
      stamped({ type: 'align', mode, sizes: measuredSizes() });
    },
    [stamped, measuredSizes]
  );

  const distributeSelection = useCallback(
    (axis: 'h' | 'v'): void => {
      stamped({ type: 'distribute', axis, sizes: measuredSizes() });
    },
    [stamped, measuredSizes]
  );

  const bindings = useMemo(
    () =>
      buildBuilderBindings({
        undo: (): void => {
          dispatch({ type: 'undo' });
        },
        redo: (): void => {
          dispatch({ type: 'redo' });
        },
        copy: (): void => {
          dispatch({ type: 'copy' });
        },
        cut: (): void => {
          stamped({ type: 'cut' });
        },
        paste: (): void => {
          stamped({ type: 'paste' });
        },
        removeSelection,
        selectAll: (): void => {
          dispatch({ type: 'select-all' });
        },
        align: alignSelection,
        distribute: distributeSelection,
        autoArrange: (): void => {
          stamped({ type: 'auto-arrange' });
        },
        fitView,
      }),
    [stamped, removeSelection, alignSelection, distributeSelection, fitView]
  );
  useKeymap({ bindings, enabled: !helpOpen });

  const helpGroups = useMemo(() => builderKeymapGroups(), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        workflowName={state.workflow.name}
        canUndo={canUndo(state.history)}
        canRedo={canRedo(state.history)}
        hasSelection={state.selectedNodes.size > 0}
        hasClipboard={state.clipboard !== null}
        onUndo={(): void => {
          dispatch({ type: 'undo' });
        }}
        onRedo={(): void => {
          dispatch({ type: 'redo' });
        }}
        onCopy={(): void => {
          dispatch({ type: 'copy' });
        }}
        onCut={(): void => {
          stamped({ type: 'cut' });
        }}
        onPaste={(): void => {
          stamped({ type: 'paste' });
        }}
        onAlign={alignSelection}
        onDistribute={distributeSelection}
        onAutoArrange={(): void => {
          stamped({ type: 'auto-arrange' });
        }}
        onFitView={fitView}
        onToggleHelp={(): void => {
          setHelpOpen(v => !v);
        }}
      />

      <div className="flex min-h-0 flex-1">
        <NodePalette onAddVariant={handlePaletteAdd} />

        <div className="min-w-0 flex-1">
          <BuilderCanvas
            nodes={nodes}
            edges={edges}
            onMoveNodes={handleMoveNodes}
            onSelectDelta={handleSelectDelta}
            onConnect={handleConnect}
            onAddNode={handleAddNode}
            onInit={(instance): void => {
              flowRef.current = instance;
            }}
            onSetSelection={handleSetSelection}
            onCopy={handleCopy}
            onCut={handleCut}
            onPaste={handlePaste}
            onDuplicate={handleDuplicate}
            onDelete={removeSelection}
            onSelectAll={handleSelectAll}
            onAutoArrange={handleAutoArrange}
            onFitView={fitView}
            hasClipboard={state.clipboard !== null}
            selectedNodeCount={state.selectedNodes.size}
            selectedEdgeCount={state.selectedEdges.size}
          />
        </div>

        <div className="flex w-[340px] shrink-0 flex-col border-l border-border bg-surface">
          <div className="flex border-b border-border">
            {(['inspect', 'yaml'] as const).map(tab => (
              <button
                key={tab}
                type="button"
                onClick={(): void => {
                  setRightTab(tab);
                }}
                className={`relative px-3 py-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] transition-colors ${
                  rightTab === tab
                    ? 'text-text-primary'
                    : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                {tab === 'inspect' ? 'Inspect' : 'YAML'}
                {rightTab === tab ? (
                  <span
                    aria-hidden
                    className="brand-bar absolute inset-x-2 bottom-0 h-[2px] rounded-t"
                  />
                ) : null}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {rightTab === 'inspect' ? (
              <Inspector
                node={selectedNode}
                selectionCount={state.selectedNodes.size}
                otherIds={state.workflow.nodes
                  .filter(n => n.id !== selectedNode?.id)
                  .map(n => n.id)}
                onPatch={(node): void => {
                  stamped({ type: 'patch-node', node });
                }}
                onRename={(id, nextId): void => {
                  stamped({ type: 'rename-node', id, nextId });
                }}
              />
            ) : (
              <YamlPreview yamlText={yamlText} />
            )}
          </div>

          <div className="max-h-56 shrink-0 border-t border-border">
            <IssueList
              issues={mergedIssues}
              onSelectNode={(nodeId): void => {
                dispatch({
                  type: 'set-selection',
                  nodeIds: new Set([nodeId]),
                  edgeIds: new Set(),
                });
                setRightTab('inspect');
              }}
            />
          </div>
        </div>
      </div>

      <KeymapHelp
        open={helpOpen}
        onClose={(): void => {
          setHelpOpen(false);
        }}
        groups={helpGroups}
      />
    </div>
  );
}
