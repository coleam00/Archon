import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ReactFlowProvider, useNodesState, useEdgesState, useViewport } from '@xyflow/react';
import type { Edge } from '@xyflow/react';
import type { WorkflowDefinition } from '@/lib/api';

import { useProject } from '@/contexts/ProjectContext';
import {
  getWorkflow,
  listCommands,
  validateWorkflow,
  saveWorkflow,
  createConversation,
  runWorkflow,
} from '@/lib/api';
import type { CommandEntry } from '@/lib/api';
import { dagNodesToReactFlow } from '@/lib/dag-layout';
import { useBuilderKeyboard } from '@/hooks/useBuilderKeyboard';
import { useBuilderUndo } from '@/hooks/useBuilderUndo';
import { useBuilderValidation } from '@/hooks/useBuilderValidation';
import type { ValidationIssue } from '@/hooks/useBuilderValidation';
import { BuilderToolbar } from './BuilderToolbar';
import type { ViewMode } from './BuilderToolbar';
import { NodeLibrary } from './NodeLibrary';
import { WorkflowCanvas, reactFlowToDagNodes } from './WorkflowCanvas';
import { NodeInspector } from './NodeInspector';
import { ValidationPanel } from './ValidationPanel';
import { StatusBar } from './StatusBar';
import { YamlCodeView } from './YamlCodeView';
import type { DagNodeData, DagFlowNode } from './DagNodeComponent';

const NODE_LIBRARY_WIDTH_KEY = 'archon:nodeLibraryWidth';
const NODE_LIBRARY_MIN_WIDTH = 160;
const NODE_LIBRARY_MAX_WIDTH = 400;
const NODE_LIBRARY_DEFAULT_WIDTH = 208; // w-52

function NodeLibraryPanel({
  commands,
  isLoading,
}: {
  commands: CommandEntry[];
  isLoading: boolean;
}): React.ReactElement {
  const [width, setWidth] = useState(() => {
    try {
      const stored = parseInt(localStorage.getItem(NODE_LIBRARY_WIDTH_KEY) ?? '', 10);
      return Number.isFinite(stored)
        ? Math.min(Math.max(stored, NODE_LIBRARY_MIN_WIDTH), NODE_LIBRARY_MAX_WIDTH)
        : NODE_LIBRARY_DEFAULT_WIDTH;
    } catch {
      return NODE_LIBRARY_DEFAULT_WIDTH;
    }
  });
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      e.preventDefault();
    },
    [width]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const next = Math.min(
        Math.max(startWidth.current + delta, NODE_LIBRARY_MIN_WIDTH),
        NODE_LIBRARY_MAX_WIDTH
      );
      setWidth(next);
    };
    const onMouseUp = (): void => {
      if (!dragging.current) return;
      dragging.current = false;
      setWidth(prev => {
        try {
          localStorage.setItem(NODE_LIBRARY_WIDTH_KEY, String(prev));
        } catch {
          // Storage unavailable or quota exceeded — width persists in memory only
        }
        return prev;
      });
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return (): void => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return (
    <div className="relative shrink-0 h-full overflow-hidden flex" style={{ width }}>
      <div className="flex-1 overflow-hidden">
        <NodeLibrary commands={commands} isLoading={isLoading} />
      </div>
      {/* Drag handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize node library panel"
        onMouseDown={onMouseDown}
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40 transition-colors z-10"
        title="Drag to resize"
      />
    </div>
  );
}

function WorkflowBuilderInner(): React.ReactElement {
  const [searchParams] = useSearchParams();
  const editName = searchParams.get('edit');
  const navigate = useNavigate();

  const { codebases, selectedProjectId } = useProject();
  const cwd = selectedProjectId
    ? codebases?.find(cb => cb.id === selectedProjectId)?.default_cwd
    : undefined;

  // Core state
  const [workflowName, setWorkflowName] = useState('');
  const [workflowDescription, setWorkflowDescription] = useState('');
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const [yamlViewMode, setYamlViewMode] = useState<ViewMode>('hidden');
  const [validationPanelOpen, setValidationPanelOpen] = useState(false);
  const [showLibrary, setShowLibrary] = useState(true);

  // DAG state
  const [nodes, setNodes, onNodesChange] = useNodesState<DagFlowNode>([]);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- TSC infers never[] without explicit Edge
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Loop state

  // Commands for palette/inspector
  const {
    data: commands,
    isError: commandsError,
    isLoading: commandsLoading,
  } = useQuery({
    queryKey: ['commands', cwd],
    queryFn: () => listCommands(cwd),
  });
  const commandList: CommandEntry[] = commands ?? [];

  const { pushSnapshot, undo, redo } = useBuilderUndo();
  const { zoom } = useViewport();

  const validationIssues = useBuilderValidation(workflowName, workflowDescription, nodes, edges);
  const errorCount = useMemo(
    () => validationIssues.filter(i => i.severity === 'error').length,
    [validationIssues]
  );
  const warningCount = useMemo(
    () => validationIssues.filter(i => i.severity === 'warning').length,
    [validationIssues]
  );

  const markDirty = useCallback((): void => {
    setHasUnsavedChanges(true);
  }, []);

  const buildDefinition = useCallback((): WorkflowDefinition => {
    const name = workflowName.trim() || 'untitled';
    const description = workflowDescription;
    const dagNodes = reactFlowToDagNodes(nodes, edges);
    return {
      name,
      description,
      provider,
      model,
      nodes: dagNodes,
    };
  }, [workflowName, workflowDescription, provider, model, nodes, edges]);

  const loadWorkflow = useCallback(
    async (name: string): Promise<void> => {
      try {
        const { workflow } = await getWorkflow(name, cwd);
        setWorkflowName(workflow.name);
        setWorkflowDescription(workflow.description);
        setProvider(workflow.provider);
        setModel(workflow.model);
        setValidationErrors([]);

        const { nodes: rfNodes, edges: rfEdges } = dagNodesToReactFlow(workflow.nodes);
        setNodes(rfNodes);
        setEdges(rfEdges);

        setHasUnsavedChanges(false);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[workflow-builder] workflow.load_failed', {
          workflowName: name,
          cwd,
          error,
        });
        setValidationErrors([`Failed to load workflow: ${error.message}`]);
      }
    },
    [cwd, setNodes, setEdges]
  );

  // Auto-load if ?edit= is present
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (editName && !autoLoaded.current) {
      autoLoaded.current = true;
      void loadWorkflow(editName);
    }
  }, [editName, loadWorkflow]);

  const handleToggleValidationPanel = useCallback((): void => {
    setValidationPanelOpen(v => !v);
  }, []);

  const handleNodeUpdate = useCallback(
    (updates: Partial<DagNodeData>): void => {
      setNodes(nds =>
        nds.map(n => (n.id === selectedNodeId ? { ...n, data: { ...n.data, ...updates } } : n))
      );
      markDirty();
    },
    [selectedNodeId, setNodes, markDirty]
  );

  const handleNodeDelete = useCallback((): void => {
    if (!selectedNodeId) return;
    pushSnapshot({ nodes, edges });
    setNodes(nds => nds.filter(n => n.id !== selectedNodeId));
    setEdges(eds => eds.filter(e => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
    markDirty();
  }, [selectedNodeId, setNodes, setEdges, markDirty, pushSnapshot, nodes, edges]);

  // Toolbar action handlers
  const handleValidate = useCallback(async (): Promise<void> => {
    try {
      const def = buildDefinition();
      const result = await validateWorkflow(def);
      if (result.valid) {
        setValidationErrors([]);
      } else {
        setValidationErrors(result.errors ?? ['Unknown validation error']);
      }
      setValidationPanelOpen(true);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      console.error('[workflow-builder] workflow.validate_failed', { workflowName, error });
      setValidationErrors([`Validation request failed: ${error.message}`]);
    }
  }, [buildDefinition]);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!workflowName.trim()) {
      setValidationErrors(['Workflow name is required']);
      return;
    }
    try {
      const def = buildDefinition();
      const validation = await validateWorkflow(def);
      if (!validation.valid) {
        setValidationErrors(validation.errors ?? ['Workflow is invalid']);
        return;
      }
      setValidationErrors([]);
      await saveWorkflow(workflowName.trim(), def, cwd);
      setHasUnsavedChanges(false);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      console.error('[workflow-builder] workflow.save_failed', { workflowName, cwd, error });
      setValidationErrors([`Save failed: ${error.message}`]);
      setValidationPanelOpen(true);
    }
  }, [buildDefinition, workflowName, cwd]);

  const handleRun = useCallback(async (): Promise<void> => {
    if (!workflowName.trim() || hasUnsavedChanges) return;
    try {
      const result = await createConversation(selectedProjectId ?? undefined);
      const conversationId = result.conversationId;
      await runWorkflow(workflowName.trim(), conversationId, '');
      navigate(`/chat/${conversationId}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      console.error('[workflow-builder] workflow.run_failed', { workflowName, error });
      setValidationErrors([`Run failed: ${error.message}`]);
      setValidationPanelOpen(true);
    }
  }, [workflowName, hasUnsavedChanges, selectedProjectId, navigate]);

  // Undo/redo handlers
  const handleUndo = useCallback((): void => {
    const state = undo();
    if (state) {
      setNodes(state.nodes);
      setEdges(state.edges);
    }
  }, [undo, setNodes, setEdges]);

  const handleRedo = useCallback((): void => {
    const state = redo();
    if (state) {
      setNodes(state.nodes);
      setEdges(state.edges);
    }
  }, [redo, setNodes, setEdges]);

  // Convert validation issues to string array for toolbar display
  const toolbarValidationErrors = useMemo(
    (): string[] => [
      ...validationErrors,
      ...validationIssues.filter(i => i.severity === 'error').map(i => i.message),
    ],
    [validationErrors, validationIssues]
  );

  // Convert validation issues for the panel (merge server-side errors with client-side)
  const allValidationIssues = useMemo((): ValidationIssue[] => {
    const serverIssues: ValidationIssue[] = validationErrors.map(msg => ({
      severity: 'error' as const,
      message: msg,
    }));
    return [...serverIssues, ...validationIssues];
  }, [validationErrors, validationIssues]);

  // Keyboard shortcuts — stabilize actions object to avoid re-registering handler on every render
  const keyboardActions = useMemo(
    () => ({
      onSave: (): void => void handleSave(),
      onUndo: handleUndo,
      onRedo: handleRedo,
      onToggleLibrary: (): void => {
        setShowLibrary(v => !v);
      },
      onToggleYaml: (): void => {
        setYamlViewMode(v => {
          const modes: ViewMode[] = ['hidden', 'split', 'full'];
          const idx = modes.indexOf(v);
          return modes[(idx + 1) % modes.length];
        });
      },
      onToggleValidation: handleToggleValidationPanel,
      onAddPrompt: (): void => {
        const id = `node-${crypto.randomUUID()}`;
        const newNode: DagFlowNode = {
          id,
          type: 'dagNode',
          position: { x: 200, y: 200 },
          data: { id, label: 'Prompt', nodeType: 'prompt' },
        };
        pushSnapshot({ nodes, edges });
        setNodes(nds => [...nds, newNode]);
        markDirty();
      },
      onAddBash: (): void => {
        const id = `node-${crypto.randomUUID()}`;
        const newNode: DagFlowNode = {
          id,
          type: 'dagNode',
          position: { x: 200, y: 200 },
          data: { id, label: 'Shell', nodeType: 'bash' },
        };
        pushSnapshot({ nodes, edges });
        setNodes(nds => [...nds, newNode]);
        markDirty();
      },
      onDeleteSelected: (): void => {
        if (selectedNodeId) {
          handleNodeDelete();
        }
      },
      onDuplicateSelected: (): void => {
        if (!selectedNodeId) return;
        const sourceNode = nodes.find(n => n.id === selectedNodeId);
        if (!sourceNode) return;
        const id = `node-${crypto.randomUUID()}`;
        const newNode: DagFlowNode = {
          id,
          type: 'dagNode',
          position: { x: sourceNode.position.x + 30, y: sourceNode.position.y + 30 },
          data: { ...sourceNode.data, id },
        };
        pushSnapshot({ nodes, edges });
        setNodes(nds => [...nds, newNode]);
        markDirty();
      },
    }),
    [
      handleSave,
      handleUndo,
      handleRedo,
      handleToggleValidationPanel,
      handleNodeDelete,
      nodes,
      edges,
      selectedNodeId,
      pushSnapshot,
      setNodes,
      markDirty,
    ]
  );
  useBuilderKeyboard(keyboardActions, true);

  const selectedNode = selectedNodeId ? nodes.find(n => n.id === selectedNodeId) : null;

  return (
    <div className="flex flex-col h-full">
      <BuilderToolbar
        workflowName={workflowName}
        workflowDescription={workflowDescription}
        provider={provider}
        model={model}
        hasUnsavedChanges={hasUnsavedChanges}
        validationErrors={toolbarValidationErrors}
        viewMode={yamlViewMode}
        onNameChange={(n): void => {
          setWorkflowName(n);
          markDirty();
        }}
        onDescriptionChange={(d): void => {
          setWorkflowDescription(d);
          markDirty();
        }}
        onProviderChange={(p): void => {
          setProvider(p);
          markDirty();
        }}
        onModelChange={(m): void => {
          setModel(m);
          markDirty();
        }}
        onViewModeChange={setYamlViewMode}
        onValidate={(): void => {
          void handleValidate();
        }}
        onSave={(): void => {
          void handleSave();
        }}
        onRun={(): void => {
          void handleRun();
        }}
        onLoadWorkflow={(name): void => {
          void loadWorkflow(name);
        }}
      />

      {commandsError && (
        <div className="px-4 py-1.5 text-xs text-error bg-surface-inset border-b border-border">
          Failed to load commands. Command palette and dropdowns may be empty.
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Node Library */}
        {showLibrary && <NodeLibraryPanel commands={commandList} isLoading={commandsLoading} />}

        {/* Center area */}
        <div className="flex-1 relative overflow-hidden flex">
          {yamlViewMode === 'full' ? (
            <YamlCodeView definition={buildDefinition()} mode="full" />
          ) : (
            <>
              <div className="flex-1 relative overflow-hidden">
                <WorkflowCanvas
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  setNodes={setNodes}
                  setEdges={setEdges}
                  onNodeSelect={setSelectedNodeId}
                  onDirty={markDirty}
                  onPushSnapshot={(): void => {
                    pushSnapshot({ nodes, edges });
                  }}
                  commands={commandList}
                />
              </div>

              {yamlViewMode === 'split' && (
                <div className="w-80 border-l border-border shrink-0">
                  <YamlCodeView definition={buildDefinition()} mode="split" />
                </div>
              )}
            </>
          )}
        </div>

        {/* Right panel: Node Inspector */}
        {selectedNodeId && selectedNode && yamlViewMode !== 'full' && (
          <div className="w-72 shrink-0">
            <NodeInspector
              node={selectedNode.data}
              commands={commandList}
              onUpdate={handleNodeUpdate}
              onDelete={handleNodeDelete}
              onClose={(): void => {
                setSelectedNodeId(null);
              }}
            />
          </div>
        )}
      </div>

      {/* Validation Panel */}
      <ValidationPanel
        issues={allValidationIssues}
        isOpen={validationPanelOpen}
        onToggle={handleToggleValidationPanel}
        onFocusNode={setSelectedNodeId}
      />

      {/* Status Bar */}
      <StatusBar
        nodeCount={nodes.length}
        edgeCount={edges.length}
        errorCount={errorCount}
        warningCount={warningCount}
        hasUnsavedChanges={hasUnsavedChanges}
        zoomLevel={Math.round(zoom * 100)}
        onValidationClick={handleToggleValidationPanel}
      />
    </div>
  );
}

export function WorkflowBuilder(): React.ReactElement {
  return (
    <ReactFlowProvider>
      <WorkflowBuilderInner />
    </ReactFlowProvider>
  );
}
