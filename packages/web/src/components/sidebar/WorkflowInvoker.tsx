import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { listWorkflows, createConversation, runWorkflow, deleteConversation } from '@/lib/api';
import { useProject } from '@/contexts/ProjectContext';

interface WorkflowInvokerProps {
  codebaseId?: string;
}

export function WorkflowInvoker({ codebaseId }: WorkflowInvokerProps): React.ReactElement | null {
  const navigate = useNavigate();
  const { codebases } = useProject();
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cwd = codebaseId ? codebases?.find(cb => cb.id === codebaseId)?.default_cwd : undefined;

  const { data: workflows, isError: isErrorWorkflows } = useQuery({
    queryKey: ['workflows', cwd ?? null],
    queryFn: () => listWorkflows(cwd),
    refetchInterval: 30_000,
  });

  if (isErrorWorkflows) {
    return <p className="mx-1 text-[10px] text-error">Failed to load workflows — retrying</p>;
  }

  if (!workflows || workflows.length === 0) return null;

  const handleRun = async (): Promise<void> => {
    if (!selectedWorkflow || !message.trim() || running) return;
    setRunning(true);
    setError(null);
    let conversationId: string | undefined;
    let workflowStarted = false;
    try {
      ({ conversationId } = await createConversation(codebaseId ?? undefined));
      await runWorkflow(selectedWorkflow, conversationId, message.trim());
      workflowStarted = true;
      setSelectedWorkflow(null);
      setMessage('');
      navigate(`/chat/${conversationId}`);
    } catch (err) {
      console.error('[WorkflowInvoker] Failed to start workflow', { err });
      setError(err instanceof Error ? err.message : 'Failed to start workflow');
      if (conversationId !== undefined && !workflowStarted) {
        void deleteConversation(conversationId).catch((cleanupErr: unknown) => {
          console.warn('[WorkflowInvoker] Failed to clean up orphan conversation', {
            conversationId,
            error: cleanupErr,
          });
        });
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 mx-1">
      <select
        value={selectedWorkflow ?? ''}
        onChange={(e): void => {
          setSelectedWorkflow(e.target.value || null);
          setError(null);
        }}
        className="w-full rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-xs text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <option value="">Run workflow...</option>
        {workflows.map(entry => (
          <option key={entry.workflow.name} value={entry.workflow.name}>
            {entry.workflow.name}
          </option>
        ))}
      </select>
      {selectedWorkflow && (
        <div className="flex flex-col gap-1.5">
          <input
            type="text"
            value={message}
            onChange={(e): void => {
              setMessage(e.target.value);
            }}
            onKeyDown={(e): void => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleRun();
              }
            }}
            placeholder="Enter message..."
            name="workflow-message"
            autoComplete="off"
            disabled={running}
            className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none disabled:opacity-50"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            {error && <span className="text-[10px] text-error flex-1 line-clamp-1">{error}</span>}
            <button
              onClick={(): void => {
                void handleRun();
              }}
              disabled={running || !message.trim()}
              className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              {running && <Loader2 className="h-3 w-3 animate-spin" />}
              {running ? 'Starting...' : 'Run'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
