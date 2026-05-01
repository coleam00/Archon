import { useState, useCallback, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileCode, Plus, Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  getWorkflow,
  saveWorkflow,
  listCommands,
  type WorkflowDefinition,
  type DagNode,
  type WorkflowSource,
  type CommandEntry,
} from '@/lib/api';
import { resolveNodeDisplay } from '@/lib/dag-layout';
import { NodeInspector } from './NodeInspector';
import { YamlCodeView, serializeToYaml, parseYamlToDefinition } from './YamlCodeView';
import type { DagNodeData } from './DagNodeComponent';
import { useProject } from '@/contexts/ProjectContext';

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function isLinearDag(nodes: DagNode[]): boolean {
  if (nodes.length === 0) return true;
  const roots = nodes.filter(n => !n.depends_on?.length);
  if (roots.length > 1) return false;
  if (nodes.some(n => (n.depends_on?.length ?? 0) > 1)) return false;
  const depCount = new Map<string, number>();
  for (const n of nodes) {
    for (const dep of n.depends_on ?? []) {
      depCount.set(dep, (depCount.get(dep) ?? 0) + 1);
    }
  }
  for (const count of depCount.values()) {
    if (count > 1) return false;
  }
  return true;
}

function topoSort(nodes: DagNode[]): DagNode[] {
  if (nodes.length === 0) return [];
  const visited = new Set<string>();
  const result: DagNode[] = [];
  let current: DagNode | undefined = nodes.find(n => !n.depends_on?.length) ?? nodes[0];
  while (current !== undefined && !visited.has(current.id)) {
    const cur: DagNode = current;
    visited.add(cur.id);
    result.push(cur);
    current = nodes.find(n => n.depends_on?.includes(cur.id));
  }
  return result;
}

function toDagNodeData(node: DagNode): DagNodeData {
  return { ...node, ...resolveNodeDisplay(node) };
}

function dagNodeDataToNode(data: DagNodeData, dependsOn: string[] | undefined): DagNode {
  const base = {
    id: data.id,
    depends_on: dependsOn?.length ? dependsOn : undefined,
    when: data.when || undefined,
    trigger_rule: data.trigger_rule || undefined,
    idle_timeout: data.idle_timeout ?? undefined,
    retry: data.retry ?? undefined,
  };

  if (data.nodeType === 'bash') {
    return { ...base, bash: data.bashScript ?? '' } as DagNode;
  }
  if (data.nodeType === 'script') {
    const s: Record<string, unknown> = { ...base, script: data.scriptBody ?? '' };
    if (data.scriptRuntime) s.runtime = data.scriptRuntime;
    if (data.scriptDeps?.length) s.deps = data.scriptDeps;
    if (data.scriptTimeout) s.timeout = data.scriptTimeout;
    return s as DagNode;
  }
  if (data.nodeType === 'approval') {
    return {
      ...base,
      approval: data.approvalConfig ?? { message: '', capture_response: false },
    } as DagNode;
  }

  const aiBase = {
    ...base,
    model: data.model || undefined,
    provider: data.provider || undefined,
    context: data.context || undefined,
    output_format: data.output_format ?? undefined,
    allowed_tools: data.allowed_tools ?? undefined,
    denied_tools: data.denied_tools ?? undefined,
    agent_ref: data.agent_ref || undefined,
    effort: data.effort ?? undefined,
    thinking: data.thinking ?? undefined,
    maxBudgetUsd: data.maxBudgetUsd ?? undefined,
    systemPrompt: data.systemPrompt ?? undefined,
    fallbackModel: data.fallbackModel ?? undefined,
    betas: data.betas ?? undefined,
    sandbox: data.sandbox ?? undefined,
  };

  if (data.nodeType === 'loop') {
    return {
      ...aiBase,
      loop: data.loopConfig ?? {
        prompt: '',
        until: '',
        max_iterations: 1,
        fresh_context: false,
      },
    } as DagNode;
  }
  if (data.nodeType === 'command') {
    return { ...aiBase, command: data.label } as DagNode;
  }
  return { ...aiBase, prompt: data.promptText ?? '' } as DagNode;
}

function newNodeId(): string {
  return `step_${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const KIND_META: Record<
  DagNodeData['nodeType'],
  { label: string; iconBg: string; iconFg: string }
> = {
  prompt: { label: 'Prompt', iconBg: 'bg-blue-50', iconFg: 'text-blue-700' },
  command: { label: 'Command', iconBg: 'bg-violet-50', iconFg: 'text-violet-700' },
  bash: { label: 'Shell', iconBg: 'bg-amber-50', iconFg: 'text-amber-700' },
  script: { label: 'Script', iconBg: 'bg-emerald-50', iconFg: 'text-emerald-700' },
  loop: { label: 'Loop', iconBg: 'bg-indigo-50', iconFg: 'text-indigo-700' },
  approval: { label: 'Approval', iconBg: 'bg-orange-50', iconFg: 'text-orange-700' },
  cancel: { label: 'Cancel', iconBg: 'bg-red-50', iconFg: 'text-red-700' },
};

function getStepTitle(node: DagNode): string {
  if (node.approval) return 'Approval gate';
  if (node.loop) return 'Loop';
  if (node.bash) return 'Shell script';
  if (node.script) return `Script (${(node as { runtime?: string }).runtime ?? 'bun'})`;
  if (node.command) return node.command;
  const prompt = typeof node.prompt === 'string' ? node.prompt : '';
  const firstLine = prompt.split('\n')[0].slice(0, 60);
  return firstLine || 'Prompt';
}

function KindIcon({ kind }: { kind: DagNodeData['nodeType'] }): React.ReactElement {
  const meta = KIND_META[kind] ?? KIND_META.prompt;
  return (
    <div
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[11px] font-bold',
        meta.iconBg,
        meta.iconFg
      )}
    >
      {meta.label[0]}
    </div>
  );
}

function Connector(): React.ReactElement {
  return (
    <div className="flex h-6 flex-col items-center justify-center">
      <div className="h-full border-l border-bridges-border" />
    </div>
  );
}

function AddStepButton({
  label = 'Add step',
  onClick,
}: {
  label?: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-bridges-border px-3 py-1 text-[12px] font-medium text-bridges-fg3 transition-colors hover:border-bridges-border-strong hover:text-bridges-fg1"
    >
      <Plus className="h-3 w-3" />
      {label}
    </button>
  );
}

interface StepCardProps {
  node: DagNode;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function StepCard({ node, selected, onSelect, onDelete }: StepCardProps): React.ReactElement {
  const kind = resolveNodeDisplay(node).nodeType;
  const meta = KIND_META[kind] ?? KIND_META.prompt;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-[360px] rounded-lg border bg-white text-left shadow-sm transition-shadow',
        selected
          ? 'border-bridges-action ring-1 ring-bridges-action/30'
          : 'border-bridges-border hover:border-bridges-border-strong'
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <KindIcon kind={kind} />
        <div className="min-w-0 flex-1">
          <div className={cn('text-[10px] font-semibold uppercase tracking-wide', meta.iconFg)}>
            {meta.label}
          </div>
          <div className="truncate text-[13px] font-semibold leading-tight text-bridges-fg1">
            {getStepTitle(node)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {node.agent_ref && (
            <span className="rounded bg-bridges-tag-violet-bg px-1.5 py-px text-[10px] font-medium text-bridges-tag-violet-fg">
              {node.agent_ref}
            </span>
          )}
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onDelete();
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-bridges-fg3 hover:bg-bridges-surface-muted hover:text-bridges-tint-danger-fg"
            aria-label={`Delete step ${node.id}`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
    </button>
  );
}

function TriggerCard({ name }: { name: string }): React.ReactElement {
  return (
    <div className="w-[360px] rounded-lg border border-bridges-border bg-white px-3 py-2.5 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-violet-50 text-[11px] font-bold text-violet-700">
          T
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-600">
            Trigger
          </div>
          <div className="truncate text-[13px] font-semibold leading-tight text-bridges-fg1">
            {name}
          </div>
        </div>
      </div>
    </div>
  );
}

function EndCard(): React.ReactElement {
  return (
    <div className="w-[360px] rounded-lg border border-bridges-border bg-white px-3 py-2.5 shadow-sm opacity-60">
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-emerald-50 text-[11px] font-bold text-emerald-700">
          ✓
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600">
            End
          </div>
          <div className="text-[13px] font-semibold leading-tight text-bridges-fg2">Complete</div>
        </div>
      </div>
    </div>
  );
}

const STEP_TYPES: { key: DagNodeData['nodeType']; label: string; desc: string }[] = [
  { key: 'prompt', label: 'Prompt', desc: 'Run an AI prompt step.' },
  { key: 'command', label: 'Command', desc: 'Invoke a named command file.' },
  { key: 'bash', label: 'Shell', desc: 'Run a shell script.' },
  { key: 'script', label: 'Script', desc: 'Run a TypeScript or Python script.' },
  { key: 'loop', label: 'Loop', desc: 'Iterate an AI prompt until a condition is met.' },
  { key: 'approval', label: 'Approval', desc: 'Pause for human approval.' },
];

function StepTypeMenu({
  onPick,
  onClose,
}: {
  onPick: (kind: DagNodeData['nodeType']) => void;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-80 rounded-xl border border-bridges-border bg-white p-2 shadow-xl"
        onClick={e => {
          e.stopPropagation();
        }}
      >
        <div className="px-3 py-2.5">
          <div className="text-[14px] font-semibold text-bridges-fg1">Add a step</div>
          <div className="mt-0.5 text-[12px] text-bridges-fg3">What should happen next?</div>
        </div>
        {STEP_TYPES.map(({ key, label, desc }) => {
          const meta = KIND_META[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                onPick(key);
              }}
              className="flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-bridges-surface-subtle"
            >
              <div
                className={cn(
                  'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[11px] font-bold',
                  meta.iconBg,
                  meta.iconFg
                )}
              >
                {label[0]}
              </div>
              <div>
                <div className="text-[13px] font-medium text-bridges-fg1">{label}</div>
                <div className="text-[12px] text-bridges-fg3">{desc}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ComplexDagNotice({ onOpenYaml }: { onOpenYaml: () => void }): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <div className="rounded-lg border border-bridges-border bg-bridges-surface px-6 py-5 shadow-sm">
        <div className="text-[15px] font-medium text-bridges-fg1">Complex DAG</div>
        <div className="mt-1 max-w-xs text-[13px] leading-relaxed text-bridges-fg3">
          This workflow has a non-linear DAG shape (multiple roots, fan-in, or diamond). The chain
          view only supports linear sequences.
        </div>
        <Button size="sm" variant="outline" className="mt-4 gap-1.5" onClick={onOpenYaml}>
          <FileCode className="h-3.5 w-3.5" />
          Open YAML view
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface WorkflowChainProps {
  name: string;
  source: WorkflowSource;
  cwd: string | undefined;
}

export function WorkflowChain({ name, source, cwd }: WorkflowChainProps): React.ReactElement {
  const queryClient = useQueryClient();
  const { selectedProjectId, codebases } = useProject();
  const effectiveCwd = cwd ?? codebases?.find(c => c.id === selectedProjectId)?.default_cwd;

  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [addingAt, setAddingAt] = useState<number | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['workflow', name, effectiveCwd ?? null],
    queryFn: () => getWorkflow(name, effectiveCwd),
    refetchOnWindowFocus: false,
  });

  const { data: commandsData } = useQuery({
    queryKey: ['commands', effectiveCwd ?? null],
    queryFn: () => listCommands(effectiveCwd),
    refetchOnWindowFocus: false,
  });
  const commandList: CommandEntry[] = commandsData ?? [];

  useEffect(() => {
    if (data?.workflow && !isDirty) {
      setDefinition(data.workflow);
    }
  }, [data?.workflow, isDirty]);

  const sorted = useMemo(() => (definition ? topoSort(definition.nodes) : []), [definition]);
  const linear = useMemo(() => (definition ? isLinearDag(definition.nodes) : true), [definition]);

  const selectedNode = useMemo(
    () => (selectedNodeId ? (sorted.find(n => n.id === selectedNodeId) ?? null) : null),
    [selectedNodeId, sorted]
  );
  const selectedNodeData = useMemo(
    () => (selectedNode ? toDagNodeData(selectedNode) : null),
    [selectedNode]
  );

  const yamlValue = useMemo(() => (definition ? serializeToYaml(definition) : ''), [definition]);

  const markDirty = useCallback((): void => {
    setIsDirty(true);
    setSaveError(null);
  }, []);

  const handleNodeUpdate = useCallback(
    (updates: Partial<DagNodeData>): void => {
      if (!selectedNodeId) return;
      const oldId = selectedNodeId;
      const newId = updates.id && updates.id !== oldId ? updates.id : undefined;

      setDefinition(prev => {
        if (!prev) return prev;
        let nodes = prev.nodes.map(n => {
          if (n.id !== oldId) return n;
          const merged: DagNodeData = { ...toDagNodeData(n), ...updates };
          return dagNodeDataToNode(merged, n.depends_on);
        });
        if (newId) {
          nodes = nodes.map(n => ({
            ...n,
            depends_on: n.depends_on?.map(dep => (dep === oldId ? newId : dep)),
          }));
        }
        return { ...prev, nodes };
      });
      if (newId) setSelectedNodeId(newId);
      markDirty();
    },
    [selectedNodeId, markDirty]
  );

  const handleDeleteStep = useCallback(
    (nodeId: string): void => {
      setDefinition(prev => {
        if (!prev) return prev;
        const target = prev.nodes.find(n => n.id === nodeId);
        if (!target) return prev;
        const nodes = prev.nodes
          .filter(n => n.id !== nodeId)
          .map(n => {
            if (!n.depends_on?.includes(nodeId)) return n;
            return {
              ...n,
              depends_on: target.depends_on?.length ? target.depends_on : undefined,
            };
          });
        return { ...prev, nodes };
      });
      if (selectedNodeId === nodeId) setSelectedNodeId(null);
      markDirty();
    },
    [selectedNodeId, markDirty]
  );

  const handleAddStep = useCallback(
    (kind: DagNodeData['nodeType']): void => {
      if (addingAt === null) return;
      const id = newNodeId();

      setDefinition(prev => {
        if (!prev) return prev;
        const cur = topoSort(prev.nodes);
        const prevNode = addingAt > 0 ? cur[addingAt - 1] : null;
        const nextNode = addingAt < cur.length ? cur[addingAt] : null;

        const dependsOn = prevNode ? [prevNode.id] : undefined;
        let newNode: DagNode;
        if (kind === 'approval') {
          newNode = { id, depends_on: dependsOn, approval: { message: '' } } as DagNode;
        } else if (kind === 'loop') {
          newNode = {
            id,
            depends_on: dependsOn,
            loop: { prompt: '', until: '', max_iterations: 5, fresh_context: false },
          } as DagNode;
        } else if (kind === 'bash') {
          newNode = { id, depends_on: dependsOn, bash: '' } as DagNode;
        } else if (kind === 'script') {
          newNode = { id, depends_on: dependsOn, script: '', runtime: 'bun' } as DagNode;
        } else if (kind === 'command') {
          newNode = { id, depends_on: dependsOn, command: '' } as DagNode;
        } else {
          newNode = { id, depends_on: dependsOn, prompt: '' } as DagNode;
        }

        const updated = prev.nodes.map(n => {
          if (n.id === nextNode?.id) {
            return { ...n, depends_on: [id] };
          }
          return n;
        });
        return { ...prev, nodes: [...updated, newNode] };
      });
      setAddingAt(null);
      markDirty();
    },
    [addingAt, markDirty]
  );

  const handleYamlChange = useCallback(
    (yaml: string): void => {
      const parsed = parseYamlToDefinition(yaml);
      if (parsed) {
        setDefinition(parsed);
        markDirty();
      }
    },
    [markDirty]
  );

  const handleSave = useCallback(async (): Promise<void> => {
    if (!definition || isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await saveWorkflow(name, definition, effectiveCwd);
      setIsDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['workflows', effectiveCwd ?? null] });
      await queryClient.invalidateQueries({
        queryKey: ['workflow', name, effectiveCwd ?? null],
      });
    } catch (e) {
      setSaveError((e as Error).message ?? 'Save failed');
    } finally {
      setIsSaving(false);
    }
  }, [definition, isSaving, name, effectiveCwd, queryClient]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-[13px] text-bridges-fg3">Loading…</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-[13px] text-bridges-tint-danger-fg">
          Failed to load workflow: {(error as Error | undefined)?.message}
        </div>
      </div>
    );
  }

  if (!definition) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-[13px] text-bridges-fg3">Loading…</div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-bridges-border-subtle bg-bridges-surface px-6">
        <span className="text-[13px] text-bridges-fg3">Workflows</span>
        <span className="text-bridges-border-strong">/</span>
        <span className="text-[13px] font-medium text-bridges-fg1">{name}</span>
        {source !== 'project' && (
          <span className="ml-1 rounded bg-bridges-surface-muted px-1.5 py-px text-[10.5px] text-bridges-fg3">
            {source}
          </span>
        )}
        <div className="flex-1" />
        {saveError && <span className="text-[12px] text-bridges-tint-danger-fg">{saveError}</span>}
        {isDirty && !saveError && (
          <span className="text-[12px] text-bridges-fg3">Unsaved changes</span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-[12px]"
          onClick={() => {
            setYamlOpen(v => !v);
          }}
        >
          <FileCode className="h-3.5 w-3.5" />
          YAML
        </Button>
        <Button
          size="sm"
          className="h-7 gap-1.5 px-3 text-[12px]"
          disabled={!isDirty || isSaving}
          onClick={() => {
            void handleSave();
          }}
        >
          <Save className="h-3.5 w-3.5" />
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {/* Workflow header */}
      <div className="shrink-0 border-b border-bridges-border-subtle bg-bridges-surface px-8 py-5">
        <input
          type="text"
          value={definition.name}
          onChange={e => {
            setDefinition(prev => (prev ? { ...prev, name: e.target.value } : prev));
            markDirty();
          }}
          className="w-full border-none bg-transparent p-0 text-[22px] font-semibold leading-tight tracking-tight text-bridges-fg1 outline-none placeholder:text-bridges-fg-placeholder"
          placeholder="Workflow name"
        />
        <input
          type="text"
          value={definition.description}
          onChange={e => {
            setDefinition(prev => (prev ? { ...prev, description: e.target.value } : prev));
            markDirty();
          }}
          className="mt-1 w-full border-none bg-transparent p-0 text-[14px] leading-relaxed text-bridges-fg2 outline-none placeholder:text-bridges-fg-placeholder"
          placeholder="What does this workflow do?"
        />
        <div className="mt-3 flex items-center gap-4 border-t border-bridges-border-subtle pt-3 text-[11px]">
          <span className="font-semibold uppercase tracking-wide text-bridges-fg3">Steps</span>
          <span className="font-mono font-semibold text-bridges-fg2">
            {definition.nodes.length}
          </span>
          {definition.interactive && (
            <>
              <span className="font-semibold uppercase tracking-wide text-bridges-fg3">Mode</span>
              <span className="rounded bg-bridges-tint-info-bg px-1.5 py-px font-medium text-bridges-tint-info-fg">
                interactive
              </span>
            </>
          )}
          {definition.tags?.slice(0, 3).map(tag => (
            <span
              key={tag}
              className="rounded bg-bridges-surface-muted px-1.5 py-px font-medium text-bridges-fg3"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      {/* Main area: canvas + inspector */}
      <div className="flex flex-1 overflow-hidden">
        {/* Canvas */}
        <div className="dot-grid flex-1 overflow-y-auto px-4 py-8">
          <div className="flex flex-col items-center">
            <TriggerCard name={definition.name} />

            {!linear && (
              <>
                <Connector />
                <ComplexDagNotice
                  onOpenYaml={() => {
                    setYamlOpen(true);
                  }}
                />
              </>
            )}

            {linear && (
              <>
                <Connector />
                <AddStepButton
                  label={sorted.length === 0 ? 'Add first step' : 'Add step'}
                  onClick={() => {
                    setAddingAt(0);
                  }}
                />

                {sorted.map((node, i) => (
                  <div key={node.id} className="flex flex-col items-center">
                    <Connector />
                    <StepCard
                      node={node}
                      selected={selectedNodeId === node.id}
                      onSelect={() => {
                        setSelectedNodeId(prev => (prev === node.id ? null : node.id));
                      }}
                      onDelete={() => {
                        handleDeleteStep(node.id);
                      }}
                    />
                    <Connector />
                    <AddStepButton
                      onClick={() => {
                        setAddingAt(i + 1);
                      }}
                    />
                  </div>
                ))}

                <Connector />
                <EndCard />
              </>
            )}
          </div>
        </div>

        {/* Node inspector panel */}
        {selectedNodeId && selectedNodeData && (
          <div className="w-72 shrink-0">
            <NodeInspector
              node={selectedNodeData}
              commands={commandList}
              onUpdate={handleNodeUpdate}
              onDelete={() => {
                handleDeleteStep(selectedNodeId);
              }}
              onClose={() => {
                setSelectedNodeId(null);
              }}
            />
          </div>
        )}
      </div>

      {/* YAML side panel */}
      <Sheet open={yamlOpen} onOpenChange={setYamlOpen}>
        <SheetContent side="right" className="flex w-[520px] max-w-[90vw] flex-col p-0">
          <SheetTitle className="sr-only">YAML editor</SheetTitle>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-[13px] font-semibold text-text-primary">YAML</span>
            <button
              type="button"
              onClick={() => {
                setYamlOpen(false);
              }}
              className="text-text-tertiary hover:text-text-primary"
              aria-label="Close YAML panel"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <YamlCodeView
              value={yamlValue}
              onChange={source === 'project' || source === 'global' ? handleYamlChange : undefined}
              mode="full"
              readOnly={source === 'bundled'}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Step type picker modal */}
      {addingAt !== null && (
        <StepTypeMenu
          onPick={handleAddStep}
          onClose={() => {
            setAddingAt(null);
          }}
        />
      )}
    </div>
  );
}
