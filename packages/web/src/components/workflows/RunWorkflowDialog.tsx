import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Play } from 'lucide-react';
import {
  createConversation,
  deleteConversation,
  listConversations,
  runWorkflow,
  type CodebaseResponse,
  type ConversationResponse,
  type WorkflowDefinition,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getWorkflowDisplayName } from '@/lib/workflow-metadata';

type RunMode = 'new' | 'append';

interface RunWorkflowDialogProps {
  workflow: WorkflowDefinition | null;
  codebases: CodebaseResponse[] | undefined;
  selectedProjectId: string | null;
  onOpenChange: (open: boolean) => void;
}

function workflowMentionsWoId(workflow: WorkflowDefinition): boolean {
  const searchable = [
    workflow.name,
    workflow.description,
    ...workflow.nodes.map(node => JSON.stringify(node)),
  ].join('\n');

  return /\bWO_ID\b/i.test(searchable);
}

function formatConversationLabel(conversation: ConversationResponse): string {
  const title = conversation.title?.trim() || conversation.platform_conversation_id;
  const suffix = conversation.last_activity_at
    ? new Date(conversation.last_activity_at).toLocaleString()
    : conversation.platform_conversation_id;

  return `${title} (${suffix})`;
}

function buildWorkflowMessage(woId: string, message: string): string {
  const parts = [];
  const trimmedWoId = woId.trim();
  const trimmedMessage = message.trim();

  if (trimmedWoId) parts.push(`WO_ID=${trimmedWoId}`);
  if (trimmedMessage) parts.push(trimmedMessage);

  return parts.join('\n');
}

export function RunWorkflowDialog({
  workflow,
  codebases,
  selectedProjectId,
  onOpenChange,
}: RunWorkflowDialogProps): React.ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isOpen = workflow !== null;
  const [codebaseId, setCodebaseId] = useState<string | null>(selectedProjectId);
  const [runMode, setRunMode] = useState<RunMode>('new');
  const [conversationId, setConversationId] = useState<string>('');
  const [woId, setWoId] = useState('');
  const [message, setMessage] = useState('run');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCodebase = codebaseId ? codebases?.find(cb => cb.id === codebaseId) : undefined;
  const requiresWoId = workflow ? workflowMentionsWoId(workflow) : false;

  const {
    data: conversations,
    isFetching: loadingConversations,
    isError: conversationsError,
  } = useQuery({
    queryKey: ['workflow-run-dialog-conversations', codebaseId ?? null],
    queryFn: () => listConversations(codebaseId ?? undefined),
    enabled: isOpen && runMode === 'append',
  });

  const targetMessage = buildWorkflowMessage(woId, message);
  const appendDisabled = runMode === 'append' && !conversationId;

  const recentConversations = useMemo(
    () =>
      [...(conversations ?? [])].sort((a, b) => {
        const left = a.last_activity_at ?? a.updated_at ?? a.created_at;
        const right = b.last_activity_at ?? b.updated_at ?? b.created_at;
        return new Date(right).getTime() - new Date(left).getTime();
      }),
    [conversations]
  );

  useEffect(() => {
    if (!isOpen) return;
    setCodebaseId(selectedProjectId);
    setRunMode('new');
    setConversationId('');
    setWoId('');
    setMessage('run');
    setError(null);
  }, [isOpen, selectedProjectId, workflow?.name]);

  useEffect(() => {
    if (runMode !== 'append') return;
    if (conversationId) return;
    const first = recentConversations[0]?.platform_conversation_id;
    if (first) setConversationId(first);
  }, [conversationId, recentConversations, runMode]);

  const handleSubmit = async (): Promise<void> => {
    if (!workflow || !targetMessage || appendDisabled || running) return;

    setRunning(true);
    setError(null);
    let createdConversationId: string | undefined;
    let workflowStarted = false;

    try {
      const targetConversationId =
        runMode === 'append'
          ? conversationId
          : (await createConversation(codebaseId ?? undefined)).conversationId;

      if (runMode === 'new') {
        createdConversationId = targetConversationId;
      }

      await runWorkflow(workflow.name, targetConversationId, targetMessage);
      workflowStarted = true;
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['workflow-runs-status'] });
      navigate(`/chat/${targetConversationId}`);
    } catch (err) {
      console.error('[RunWorkflowDialog] Failed to run workflow', { err });
      setError(err instanceof Error ? err.message : 'Failed to start workflow');
      if (createdConversationId !== undefined && !workflowStarted) {
        void deleteConversation(createdConversationId).catch((cleanupErr: unknown) => {
          console.warn('[RunWorkflowDialog] Failed to clean up orphan conversation', {
            conversationId: createdConversationId,
            error: cleanupErr,
          });
        });
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {workflow ? `Run ${getWorkflowDisplayName(workflow.name)}` : 'Run workflow'}
          </DialogTitle>
          <DialogDescription>
            Choose where the workflow should run and the message sent to the agent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2">
            <label className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
              Codebase
            </label>
            <select
              value={codebaseId ?? ''}
              onChange={(e): void => {
                setCodebaseId(e.target.value || null);
                setConversationId('');
              }}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              disabled={running}
            >
              <option value="">No codebase</option>
              {codebases?.map(cb => (
                <option key={cb.id} value={cb.id}>
                  {cb.name}
                </option>
              ))}
            </select>
            {selectedCodebase && (
              <p className="truncate text-xs text-text-tertiary">{selectedCodebase.default_cwd}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={(): void => {
                setRunMode('new');
                setError(null);
              }}
              className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                runMode === 'new'
                  ? 'border-accent bg-accent/10 text-text-primary'
                  : 'border-border bg-surface text-text-secondary hover:text-text-primary'
              }`}
              disabled={running}
            >
              New conversation
            </button>
            <button
              type="button"
              onClick={(): void => {
                setRunMode('append');
                setError(null);
              }}
              className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                runMode === 'append'
                  ? 'border-accent bg-accent/10 text-text-primary'
                  : 'border-border bg-surface text-text-secondary hover:text-text-primary'
              }`}
              disabled={running}
            >
              Append to existing
            </button>
          </div>

          {runMode === 'append' && (
            <div className="grid gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                Conversation
              </label>
              <select
                value={conversationId}
                onChange={(e): void => {
                  setConversationId(e.target.value);
                }}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                disabled={running || loadingConversations}
              >
                <option value="">
                  {loadingConversations ? 'Loading conversations...' : 'Select conversation'}
                </option>
                {recentConversations.map(conv => (
                  <option key={conv.platform_conversation_id} value={conv.platform_conversation_id}>
                    {formatConversationLabel(conv)}
                  </option>
                ))}
              </select>
              {conversationsError && (
                <p className="text-xs text-error">Failed to load conversations.</p>
              )}
            </div>
          )}

          {requiresWoId && (
            <div className="grid gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                WO_ID
              </label>
              <input
                value={woId}
                onChange={(e): void => {
                  setWoId(e.target.value);
                }}
                placeholder="WO-..."
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
                disabled={running}
              />
            </div>
          )}

          <div className="grid gap-2">
            <label className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
              Initial message
            </label>
            <textarea
              value={message}
              onChange={(e): void => {
                setMessage(e.target.value);
              }}
              rows={4}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
              disabled={running}
            />
          </div>

          {error && <p className="text-sm text-error">{error}</p>}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={(): void => {
                onOpenChange(false);
              }}
              disabled={running}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={(): void => {
                void handleSubmit();
              }}
              disabled={running || !targetMessage || appendDisabled}
            >
              {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {running ? 'Starting...' : 'Run workflow'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
