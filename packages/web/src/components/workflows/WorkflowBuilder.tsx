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
  testRunWorkflow,
} from '@/lib/api';
import type { CommandEntry, WorkflowSource } from '@/lib/api';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { WorkflowExecution } from './WorkflowExecution';
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
import { YamlCodeView, serializeToYaml, parseYamlToDefinition } from './YamlCodeView';
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
  const [loadedSource, setLoadedSource] = useState<WorkflowSource | null>(null);
  const isReadOnly = loadedSource === 'bundled';

  const [yamlViewMode, setYamlViewMode] = useState<ViewMode>('hidden');
  const [validationPanelOpen, setValidationPanelOpen] = useState(false);
  const [showLibrary, setShowLibrary] = useState(true);

  // DAG state
  const [nodes, setNodes, onNodesChange] = useNodesState<DagFlowNode>([]);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- TSC infers never[] without explicit Edge
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // YAML editor state — bidirectional with the canvas.
  const [yamlText, setYamlText] = useState<string>('');
  // 'canvas' = canvas was just edited (re-serialize YAML).
  // 'yaml'   = user is editing YAML (parse+push to canvas, don't re-serialize).
  // 'load'   = programmatic load (refresh both surfaces from definition).
  const editSourceRef = useRef<'canvas' | 'yaml' | 'load'>('canvas');

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
    editSourceRef.current = 'canvas';
    setHasUnsavedChanges(true);
  }, []);

  // Refs mirror the latest nodes/edges so snapshot-taking callbacks don't
  // close over stale values when events fire in the same tick as a render.
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [nodes, edges]);

  const pushSnapshotLatest = useCallback((): void => {
    pushSnapshot({ nodes: nodesRef.current, edges: edgesRef.current });
  }, [pushSnapshot]);

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

  // Canvas → YAML: re-serialize whenever the canvas changes, unless YAML is the active source.
  useEffect(() => {
    if (editSourceRef.current === 'yaml') return;
    setYamlText(serializeToYaml(buildDefinition()));
    if (editSourceRef.current === 'load') {
      // After a programmatic load, future edits start from canvas.
      editSourceRef.current = 'canvas';
    }
  }, [buildDefinition]);

  // YAML → Canvas: debounced parse-and-push when the user types in the editor.
  useEffect(() => {
    if (editSourceRef.current !== 'yaml') return;
    const timer = setTimeout(() => {
      let parsed: WorkflowDefinition | null;
      try {
        parsed = parseYamlToDefinition(yamlText);
      } catch {
        // Syntax errors surface as CodeMirror lint markers; do not clobber the canvas.
        return;
      }
      if (!parsed) return;
      // Best-effort push: tolerate partial workflow shape so the user can keep editing.
      if (typeof parsed.name === 'string') setWorkflowName(parsed.name);
      if (typeof parsed.description === 'string') setWorkflowDescription(parsed.description);
      if (typeof parsed.provider === 'string' || parsed.provider === undefined) {
        setProvider(parsed.provider);
      }
      if (typeof parsed.model === 'string' || parsed.model === undefined) {
        setModel(parsed.model);
      }
      if (Array.isArray(parsed.nodes)) {
        try {
          const { nodes: rfNodes, edges: rfEdges } = dagNodesToReactFlow(parsed.nodes);
          setNodes(rfNodes);
          setEdges(rfEdges);
          setSelectedNodeId(prev => (prev && rfNodes.some(n => n.id === prev) ? prev : null));
        } catch (err) {
          console.warn('[workflow-builder] yaml.apply_failed', err);
        }
      }
      setHasUnsavedChanges(true);
    }, 350);
    return (): void => {
      clearTimeout(timer);
    };
  }, [yamlText, setNodes, setEdges]);

  const handleYamlChange = useCallback((next: string): void => {
    editSourceRef.current = 'yaml';
    setYamlText(next);
  }, []);

  const loadWorkflow = useCallback(
    async (name: string): Promise<void> => {
      try {
        const { workflow, source } = await getWorkflow(name, cwd);
        editSourceRef.current = 'load';
        setWorkflowName(workflow.name);
        setWorkflowDescription(workflow.description);
        setProvider(workflow.provider);
        setModel(workflow.model);
        setLoadedSource(source);
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

  const handleNodeDeleteById = useCallback(
    (nodeId: string): void => {
      pushSnapshotLatest();
      setNodes(nds => nds.filter(n => n.id !== nodeId));
      setEdges(eds => eds.filter(e => e.source !== nodeId && e.target !== nodeId));
      setSelectedNodeId(prev => (prev === nodeId ? null : prev));
      markDirty();
    },
    [setNodes, setEdges, markDirty, pushSnapshotLatest]
  );

  const handleNodeDelete = useCallback((): void => {
    // If multiple nodes are box-selected, delete all of them. Otherwise, fall back
    // to the inspector's currently focused node.
    const selectedIds = nodes.filter(n => n.selected).map(n => n.id);
    if (selectedIds.length > 1) {
      pushSnapshotLatest();
      const idSet = new Set(selectedIds);
      setNodes(nds => nds.filter(n => !idSet.has(n.id)));
      setEdges(eds => eds.filter(e => !idSet.has(e.source) && !idSet.has(e.target)));
      setSelectedNodeId(prev => (prev && idSet.has(prev) ? null : prev));
      markDirty();
      return;
    }
    if (!selectedNodeId) return;
    handleNodeDeleteById(selectedNodeId);
  }, [
    selectedNodeId,
    handleNodeDeleteById,
    nodes,
    setNodes,
    setEdges,
    markDirty,
    pushSnapshotLatest,
  ]);

  // Internal clipboard for copy/paste. Stored in a ref so we don't trigger renders
  // and so paste can run from a keyboard handler that closes over a stable ref.
  const clipboardRef = useRef<{ nodes: DagFlowNode[]; edges: Edge[] } | null>(null);

  const handleCopySelected = useCallback((): void => {
    const selected = nodes.filter(n => n.selected);
    if (selected.length === 0) return;
    const idSet = new Set(selected.map(n => n.id));
    const intraEdges = edges.filter(e => idSet.has(e.source) && idSet.has(e.target));
    clipboardRef.current = {
      nodes: selected.map(n => ({ ...n, data: { ...n.data } })),
      edges: intraEdges.map(e => ({ ...e })),
    };
  }, [nodes, edges]);

  const handlePaste = useCallback((): void => {
    const clip = clipboardRef.current;
    if (!clip || clip.nodes.length === 0) return;
    pushSnapshotLatest();
    // Build an old-id → new-id map so cloned edges can be remapped.
    const idMap = new Map<string, string>();
    for (const n of clip.nodes) {
      idMap.set(n.id, `node-${crypto.randomUUID()}`);
    }
    const PASTE_OFFSET = 40;
    const newNodes: DagFlowNode[] = clip.nodes.map(n => {
      const newId = idMap.get(n.id) ?? n.id;
      return {
        ...n,
        id: newId,
        position: { x: n.position.x + PASTE_OFFSET, y: n.position.y + PASTE_OFFSET },
        selected: true,
        data: { ...n.data, id: newId },
      };
    });
    const newEdges: Edge[] = clip.edges.map(e => {
      const src = idMap.get(e.source) ?? e.source;
      const tgt = idMap.get(e.target) ?? e.target;
      return {
        ...e,
        id: `${src}->${tgt}-${crypto.randomUUID().slice(0, 8)}`,
        source: src,
        target: tgt,
      };
    });
    // Deselect existing nodes; the freshly pasted set takes selection.
    setNodes(nds => [...nds.map(n => ({ ...n, selected: false })), ...newNodes]);
    setEdges(eds => [...eds, ...newEdges]);
    markDirty();
  }, [pushSnapshotLatest, setNodes, setEdges, markDirty]);

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
    if (isReadOnly) {
      setValidationErrors(['Bundled workflows are read-only. Use "Fork to project" instead.']);
      setValidationPanelOpen(true);
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
      const result = await saveWorkflow(workflowName.trim(), def, cwd);
      setLoadedSource(result.source);
      setHasUnsavedChanges(false);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      console.error('[workflow-builder] workflow.save_failed', { workflowName, cwd, error });
      setValidationErrors([`Save failed: ${error.message}`]);
      setValidationPanelOpen(true);
    }
  }, [buildDefinition, workflowName, cwd, isReadOnly]);

  // Fork the bundled workflow into a project-scoped copy. The user can rename the
  // workflow first if they want to keep the bundled name reachable; we default to
  // suffixing with "-fork" to avoid silently shadowing.
  const handleFork = useCallback(async (): Promise<void> => {
    const baseName = workflowName.trim() || 'untitled';
    const proposed = `${baseName}-fork`;
    const newName = window.prompt('Fork bundled workflow as:', proposed);
    if (!newName) return;
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      const def: WorkflowDefinition = { ...buildDefinition(), name: trimmed };
      const validation = await validateWorkflow(def);
      if (!validation.valid) {
        setValidationErrors(validation.errors ?? ['Workflow is invalid']);
        setValidationPanelOpen(true);
        return;
      }
      const result = await saveWorkflow(trimmed, def, cwd);
      setWorkflowName(trimmed);
      setLoadedSource(result.source);
      setHasUnsavedChanges(false);
      setValidationErrors([]);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      console.error('[workflow-builder] workflow.fork_failed', { workflowName, error });
      setValidationErrors([`Fork failed: ${error.message}`]);
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

  // Test Run drawer — opens a slide-over with WorkflowExecution streaming events for the run.
  const [testRunDrawerOpen, setTestRunDrawerOpen] = useState(false);
  const [testRunTempName, setTestRunTempName] = useState<string | null>(null);
  const [testRunRunId, setTestRunRunId] = useState<string | null>(null);
  const [testRunPending, setTestRunPending] = useState(false);

  // Once the test run dispatches, poll the runs API and pick the row whose workflow_name
  // matches the temp name we just spawned. The platform conversation we created is the
  // parent — the actual run row is keyed off a worker conversation we don't know.
  useEffect(() => {
    if (!testRunTempName || testRunRunId) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/workflows/runs?limit=20');
        if (!res.ok) return;
        const data = (await res.json()) as {
          runs: { id: string; workflow_name: string }[];
        };
        if (cancelled) return;
        const match = data.runs.find(r => r.workflow_name === testRunTempName);
        if (match) {
          setTestRunRunId(match.id);
          clearInterval(interval);
        }
      } catch (e) {
        console.warn('[workflow-builder] testrun.run_lookup_failed', e);
      }
    }, 800);
    return (): void => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [testRunTempName, testRunRunId]);

  const handleTestRun = useCallback(async (): Promise<void> => {
    if (testRunPending) return;
    setTestRunPending(true);
    try {
      const def = buildDefinition();
      // Reset prior drawer state.
      setTestRunRunId(null);
      setTestRunTempName(null);
      const result = await testRunWorkflow(def, {
        codebaseId: selectedProjectId ?? undefined,
        cwd,
      });
      setTestRunTempName(result.tempName);
      setTestRunDrawerOpen(true);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      console.error('[workflow-builder] workflow.test_run_failed', { error });
      setValidationErrors([`Test run failed: ${error.message}`]);
      setValidationPanelOpen(true);
    } finally {
      setTestRunPending(false);
    }
  }, [buildDefinition, cwd, selectedProjectId, testRunPending]);

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
        pushSnapshotLatest();
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
        pushSnapshotLatest();
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
        pushSnapshotLatest();
        setNodes(nds => [...nds, newNode]);
        markDirty();
      },
      onCopySelected: handleCopySelected,
      onPaste: handlePaste,
      onSelectAll: (): void => {
        setNodes(nds => nds.map(n => ({ ...n, selected: true })));
      },
    }),
    [
      handleSave,
      handleUndo,
      handleRedo,
      handleToggleValidationPanel,
      handleNodeDelete,
      handleCopySelected,
      handlePaste,
      nodes,
      selectedNodeId,
      pushSnapshotLatest,
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
        hasClientErrors={errorCount > 0}
        loadedSource={loadedSource}
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
        onTestRun={(): void => {
          void handleTestRun();
        }}
        onFork={(): void => {
          void handleFork();
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
            <YamlCodeView
              value={yamlText}
              onChange={isReadOnly ? undefined : handleYamlChange}
              mode="full"
              readOnly={isReadOnly}
            />
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
                  onNodeDelete={handleNodeDeleteById}
                  onDirty={markDirty}
                  onPushSnapshot={pushSnapshotLatest}
                  commands={commandList}
                  readOnly={isReadOnly}
                />
              </div>

              {yamlViewMode === 'split' && (
                <div className="w-96 border-l border-border shrink-0">
                  <YamlCodeView
                    value={yamlText}
                    onChange={isReadOnly ? undefined : handleYamlChange}
                    mode="split"
                    readOnly={isReadOnly}
                  />
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

      {/* Test Run Drawer — slide-over with live workflow execution. */}
      <Sheet open={testRunDrawerOpen} onOpenChange={setTestRunDrawerOpen}>
        <SheetContent side="right" className="!max-w-3xl w-full p-0 flex flex-col">
          <SheetHeader className="border-b border-border px-4 py-3">
            <SheetTitle className="text-sm">
              Test Run{testRunRunId ? '' : ' — starting…'}
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden">
            {testRunRunId ? (
              <WorkflowExecution runId={testRunRunId} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-text-tertiary">
                Waiting for the workflow run to register…
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
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
