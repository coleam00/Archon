import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, MoreHorizontal, Sliders, Trash2, ShieldCheck } from 'lucide-react';
import { deleteAgent, getAgent, saveAgent, type AgentDetail, type AgentSource } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/skills/ConfirmDialog';
import { SegmentedTabs } from './SegmentedTabs';
import { detailToDraft, draftIsDirty, draftToFrontmatter, type AgentDraft } from './agent-draft';
import { IdentityTab } from './IdentityTab';
import { SkillsTab } from './SkillsTab';
import { ToolsTab } from './ToolsTab';
import { MCPTab } from './MCPTab';
import { ChatPreview } from './ChatPreview';
import { ValidateAgentSheet } from './ValidateAgentSheet';

interface AgentEditorProps {
  cwd: string | undefined;
  name: string | null;
  source: AgentSource | null;
  onDeleted: () => void;
}

const TABS = ['Identity', 'Skills', 'Tools', 'MCP'] as const;
type Tab = (typeof TABS)[number];

export function AgentEditor({
  cwd,
  name,
  source,
  onDeleted,
}: AgentEditorProps): React.ReactElement {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('Identity');
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [validateOpen, setValidateOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const enabled = name !== null && source !== null;
  const detailQuery = useQuery<AgentDetail>({
    queryKey: ['agent', source, name, cwd ?? null],
    queryFn: () => {
      if (name === null || source === null) {
        throw new Error('agent query enabled with no selection');
      }
      return getAgent(name, source, cwd);
    },
    enabled,
    refetchOnWindowFocus: false,
  });

  // Sync draft from server detail when the selection changes or the file
  // is refetched after a save.
  useEffect(() => {
    if (detailQuery.data) setDraft(detailToDraft(detailQuery.data));
  }, [detailQuery.data]);

  const baseline = useMemo(
    () => (detailQuery.data ? detailToDraft(detailQuery.data) : null),
    [detailQuery.data]
  );
  const dirty = !!(draft && baseline && draftIsDirty(draft, baseline));

  const saveMutation = useMutation({
    mutationFn: async (d: AgentDraft) => {
      if (!name || !source) throw new Error('No agent selected');
      return saveAgent(name, {
        source,
        frontmatter: draftToFrontmatter(d),
        body: d.body,
        ...(cwd ? { cwd } : {}),
      });
    },
    onSuccess: detail => {
      qc.setQueryData(['agent', source, name, cwd ?? null], detail);
      qc.invalidateQueries({ queryKey: ['agents', cwd ?? null] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!name || !source) throw new Error('No agent selected');
      return deleteAgent(name, source, cwd);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents', cwd ?? null] });
      onDeleted();
    },
  });

  if (!enabled) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-bridges-fg3">
        Select an agent to edit, or create a new one.
      </div>
    );
  }

  if (detailQuery.isLoading || !draft) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-bridges-fg3">
        Loading agent…
      </div>
    );
  }

  if (detailQuery.isError) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-bridges-tint-danger-fg">
        Failed to load agent: {(detailQuery.error as Error | undefined)?.message}
      </div>
    );
  }

  const detail = detailQuery.data;
  if (!detail) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-bridges-fg3">
        Loading agent…
      </div>
    );
  }

  function patch(p: Partial<AgentDraft>): void {
    setDraft(prev => (prev ? { ...prev, ...p } : prev));
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-bridges-surface">
      {/* Top bar */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-bridges-border-subtle bg-bridges-surface px-5">
        <span className="text-[13px] text-bridges-fg3">Agents</span>
        <span className="text-bridges-border-strong">/</span>
        <span className="truncate text-[13px] font-medium text-bridges-fg1">{detail.name}</span>
        <span
          className={cn(
            'ml-1 inline-flex items-center rounded px-1.5 py-px text-[10.5px] font-medium leading-tight',
            detail.status === 'active' && 'bg-bridges-tint-success-bg text-bridges-tint-success-fg',
            detail.status === 'draft' && 'bg-bridges-tint-warning-bg text-bridges-tint-warning-fg',
            detail.status === 'archived' && 'bg-bridges-surface-muted text-bridges-fg2'
          )}
        >
          {detail.status[0].toUpperCase() + detail.status.slice(1)}
        </span>
        <span className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-3 text-[12.5px]"
          onClick={() => {
            setValidateOpen(true);
          }}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          Validate
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-3 text-[12.5px]"
          disabled
          title="Duplicate (coming soon)"
        >
          <Copy className="h-3.5 w-3.5" />
          Duplicate
        </Button>
        <Button
          size="sm"
          className="h-8 gap-1.5 px-3 text-[12.5px]"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => {
            saveMutation.mutate(draft);
          }}
        >
          <Check className="h-3.5 w-3.5" />
          {saveMutation.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </Button>
        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-bridges-fg2"
            onClick={() => {
              setMenuOpen(o => !o);
            }}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                onClick={() => {
                  setMenuOpen(false);
                }}
              />
              <div className="absolute right-0 top-full z-40 mt-1 min-w-[160px] rounded-md border border-bridges-border bg-bridges-surface py-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirmDelete(true);
                  }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-bridges-tint-danger-fg hover:bg-bridges-tint-danger-bg"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete agent
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Body: chat preview (left) + configure rail (right) */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 border-r border-bridges-border-subtle">
          <ChatPreview
            cwd={cwd}
            name={detail.name}
            source={detail.source}
            description={detail.description}
            status={detail.status}
          />
        </div>

        <div className="flex w-[440px] shrink-0 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-bridges-border-subtle px-5 text-[13px] font-semibold text-bridges-fg1">
            <Sliders className="h-3.5 w-3.5 text-bridges-fg2" />
            Configure Agent
          </div>
          <SegmentedTabs tabs={TABS} value={tab} onChange={setTab} />
          <div className="flex-1 overflow-y-auto px-5 py-5">
            {tab === 'Identity' && <IdentityTab draft={draft} onPatch={patch} />}
            {tab === 'Skills' && <SkillsTab draft={draft} cwd={cwd} onPatch={patch} />}
            {tab === 'Tools' && <ToolsTab draft={draft} onPatch={patch} />}
            {tab === 'MCP' && <MCPTab draft={draft} onPatch={patch} />}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete agent?"
        description={`This will permanently delete '${detail.name}'. Workflows referencing this agent via agent_ref will fail validation.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          setConfirmDelete(false);
          deleteMutation.mutate();
        }}
      />

      {validateOpen && (
        <ValidateAgentSheet
          name={detail.name}
          source={detail.source}
          cwd={cwd}
          onClose={() => {
            setValidateOpen(false);
          }}
        />
      )}
    </div>
  );
}
