import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { listLinearIssues, updateLinearIssue, type LinearIssue } from '@/lib/api';
import { cn } from '@/lib/utils';

const STATE_ORDER: Record<string, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
};

/**
 * Linear-state kanban with bidirectional sync.
 *
 * - Reads via `GET /api/linear/issues` (proxies to Linear's GraphQL `issues`
 *   query for the configured project; no local cache yet).
 * - Drag a card between state columns → `PATCH /api/linear/issues/{id}` with
 *   `{ stateId }` → Linear's `issueUpdate` mutation. Optimistic UI; the next
 *   refetch is the source of truth.
 *
 * Phase 3 ships read + write. Inbound webhook (`POST /webhooks/linear`) for
 * sub-second propagation from Linear → MC is deferred — the polling refetch
 * picks up external changes within ~15s.
 */
export function LinearKanban(): React.ReactElement {
  const queryClient = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const {
    data: issues,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['mission.linear.issues'],
    queryFn: () => listLinearIssues(),
    refetchInterval: 15_000,
  });

  // Build the column set from the loaded issues. A column appears when at
  // least one issue is in that state. Sort by Linear `state.type` so the lane
  // order roughly matches Linear's web UI: backlog → unstarted → started →
  // completed → canceled.
  const columns = useMemo(() => {
    if (!issues) return [];
    const seen = new Map<string, { id: string; name: string; type: string }>();
    for (const i of issues) {
      if (i.state && !seen.has(i.state.id)) seen.set(i.state.id, i.state);
    }
    return [...seen.values()].sort((a, b) => {
      const ord = (STATE_ORDER[a.type] ?? 99) - (STATE_ORDER[b.type] ?? 99);
      return ord !== 0 ? ord : a.name.localeCompare(b.name);
    });
  }, [issues]);

  const grouped = useMemo(() => {
    const map = new Map<string, LinearIssue[]>();
    for (const i of issues ?? []) {
      const key = i.state?.id ?? '__no_state__';
      const list = map.get(key) ?? [];
      list.push(i);
      map.set(key, list);
    }
    return map;
  }, [issues]);

  async function handleDragEnd(event: DragEndEvent): Promise<void> {
    const issueId = String(event.active.id);
    const targetStateId = event.over?.id ? String(event.over.id) : null;
    if (!targetStateId) return;
    const issue = issues?.find(i => i.id === issueId);
    if (!issue) return;
    if (issue.state?.id === targetStateId) return;

    // Optimistic: write the new stateId to the cached issues immediately so
    // the card visually moves. Refetch on settle restores authoritative state.
    queryClient.setQueryData<LinearIssue[]>(['mission.linear.issues'], prev => {
      if (!prev) return prev;
      return prev.map(i => {
        if (i.id !== issueId) return i;
        const newState = columns.find(c => c.id === targetStateId);
        return newState ? { ...i, state: newState } : i;
      });
    });
    try {
      await updateLinearIssue(issueId, { stateId: targetStateId });
    } catch (e) {
      // Rollback by invalidating — the refetch will restore the prior state.
      console.error('Linear issueUpdate failed', e);
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['mission.linear.issues'] });
    }
  }

  if (isLoading) return <p className="text-sm text-text-secondary">Loading Linear backlog…</p>;
  if (error) {
    const msg = error instanceof Error ? error.message : 'Failed to load';
    if (msg.includes('503')) {
      return (
        <div className="rounded-md border border-dashed border-border bg-surface-elevated p-6 text-center">
          <p className="text-sm font-medium text-text-primary">Linear tracker not configured</p>
          <p className="mt-1 text-xs text-text-secondary">
            Add a Linear tracker block to <code>~/.archon/symphony.yaml</code> to use the Linear
            kanban.
          </p>
        </div>
      );
    }
    return <p className="text-sm text-error">{msg}</p>;
  }
  if (!issues || issues.length === 0) {
    return (
      <p className="text-sm text-text-secondary">
        No Linear issues found in the configured project.
      </p>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      onDragEnd={e => {
        void handleDragEnd(e);
      }}
    >
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map(col => (
          <LinearLane key={col.id} column={col} issues={grouped.get(col.id) ?? []} />
        ))}
      </div>
    </DndContext>
  );
}

function laneBorder(type: string): string {
  switch (type) {
    case 'started':
      return 'border-primary/40';
    case 'completed':
      return 'border-success/40';
    case 'canceled':
      return 'border-error/40';
    default:
      return 'border-border';
  }
}

function LinearLane({
  column,
  issues,
}: {
  column: { id: string; name: string; type: string };
  issues: LinearIssue[];
}): React.ReactElement {
  const { isOver, setNodeRef } = useDroppable({ id: column.id });
  const toneBorder = laneBorder(column.type);
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-md border bg-surface-elevated p-2 transition-colors',
        toneBorder,
        isOver && 'bg-primary/5 ring-1 ring-primary'
      )}
    >
      <div className="mb-2 flex items-center justify-between border-b border-border pb-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {column.name}
        </span>
        <span className="text-xs text-text-tertiary">{issues.length}</span>
      </div>
      <ul className="space-y-2">
        {issues.length === 0 && (
          <li className="rounded-md border border-dashed border-border bg-surface px-2 py-3 text-center text-[11px] text-text-tertiary">
            empty
          </li>
        )}
        {issues.map(issue => (
          <LinearCard key={issue.id} issue={issue} />
        ))}
      </ul>
    </div>
  );
}

function LinearCard({ issue }: { issue: LinearIssue }): React.ReactElement {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: issue.id });
  return (
    <li
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        'cursor-grab rounded-md border border-border bg-surface px-2 py-2 text-sm shadow-sm hover:bg-surface-elevated active:cursor-grabbing',
        isDragging && 'opacity-40'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-mono text-text-tertiary">{issue.identifier}</span>
        {issue.url && (
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => {
              e.stopPropagation();
            }}
            className="text-[11px] text-primary hover:underline"
          >
            open ↗
          </a>
        )}
      </div>
      <p className="mt-1 line-clamp-2 text-text-primary">{issue.title}</p>
    </li>
  );
}
