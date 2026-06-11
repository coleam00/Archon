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
}

const VALIDATION_DEBOUNCE_MS = 300;

/** Distributive omit of `at` across the timestamped action union. */
type UnstampedAction = EditorAction extends infer A
  ? A extends { at: number }
    ? Omit<A, 'at'>
    : never
  : never;

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function BuilderPage({ initialWorkflow, onChange }: BuilderPageProps): ReactElement {
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
  const initialRef = useRef(true);
  useEffect(() => {
    if (initialRef.current) {
      initialRef.current = false;
      return;
    }
    onChange?.(state.workflow);
  }, [state.workflow, onChange]);

  const { nodes, edges } = useMemo(() => {
    const derived = builderToFlow(state.workflow, state.positions, state.selectedNodes);
    return {
      nodes: derived.nodes,
      edges: derived.edges.map(e => (state.selectedEdges.has(e.id) ? { ...e, selected: true } : e)),
    };
  }, [state.workflow, state.positions, state.selectedNodes, state.selectedEdges]);

  const yamlText = useMemo(
    () => serializeToYaml(toWorkflowDefinition(state.workflow)),
    [state.workflow]
  );

  const selectedNode =
    state.selectedNodes.size === 1
      ? (state.workflow.nodes.find(n => state.selectedNodes.has(n.id)) ?? null)
      : null;

  const handleSelectionChange = useCallback(
    (nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>): void => {
      // The canvas echoes selection on every derived-prop change; only
      // dispatch when it actually moved to avoid render loops.
      if (setsEqual(nodeIds, state.selectedNodes) && setsEqual(edgeIds, state.selectedEdges)) {
        return;
      }
      dispatch({ type: 'set-selection', nodeIds, edgeIds });
    },
    [state.selectedNodes, state.selectedEdges]
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

  const removeSelection = useCallback((): void => {
    if (state.selectedEdges.size > 0) {
      stamped({ type: 'remove-edges', edgeIds: [...state.selectedEdges] });
    }
    if (state.selectedNodes.size > 0) {
      stamped({ type: 'remove-nodes', ids: [...state.selectedNodes] });
    }
  }, [stamped, state.selectedEdges, state.selectedNodes]);

  const fitView = useCallback((): void => {
    void flowRef.current?.fitView({ padding: 0.2, duration: 200 });
  }, []);

  const alignSelection = useCallback(
    (mode: AlignMode): void => {
      stamped({ type: 'align', mode });
    },
    [stamped]
  );

  const distributeSelection = useCallback(
    (axis: 'h' | 'v'): void => {
      stamped({ type: 'distribute', axis });
    },
    [stamped]
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
            onSelectionChange={handleSelectionChange}
            onConnect={handleConnect}
            onAddNode={handleAddNode}
            onInit={(instance): void => {
              flowRef.current = instance;
            }}
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
              issues={issues}
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
