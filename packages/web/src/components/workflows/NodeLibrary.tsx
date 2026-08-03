import { useState, useMemo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { categorizeCommands } from '@/lib/command-categories';
import type { CommandEntry } from '@/lib/api';

interface NodeLibraryProps {
  commands: CommandEntry[];
  isLoading: boolean;
}

const NODE_TYPE_COLORS: Record<string, string> = {
  command: 'bg-node-command',
  prompt: 'bg-node-prompt',
  bash: 'bg-node-bash',
};

function onDragStart(e: React.DragEvent, type: 'command' | 'prompt' | 'bash', name: string): void {
  e.dataTransfer.setData('application/reactflow-type', type);
  e.dataTransfer.setData('application/reactflow-command', name);
  e.dataTransfer.effectAllowed = 'move';
}

function LoadingSkeleton(): React.ReactElement {
  return (
    <div className="flex flex-col gap-2 p-2">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="h-7 rounded-md bg-surface-elevated animate-pulse" />
      ))}
    </div>
  );
}

function DraggableItem({
  type,
  name,
  displayName,
}: {
  type: 'command' | 'prompt' | 'bash';
  name: string;
  displayName: string;
}): React.ReactElement {
  return (
    <div
      draggable
      onDragStart={(e): void => {
        onDragStart(e, type, name);
      }}
      className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-dashed border-border hover:border-accent hover:bg-accent/5 cursor-grab text-xs text-text-primary"
    >
      <span className={cn('w-2 h-2 rounded-full shrink-0', NODE_TYPE_COLORS[type])} />
      <span className="font-mono truncate">{displayName}</span>
    </div>
  );
}

function CollapsibleSection({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  count: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={(): void => {
          setOpen(!open);
        }}
        className="flex items-center gap-1 px-1 py-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wide hover:text-text-secondary"
      >
        <span className="text-text-tertiary">{open ? '\u25BE' : '\u25B8'}</span>
        <span>{title}</span>
        <span className="text-text-tertiary ml-auto">({count})</span>
      </button>
      {open && <div className="flex flex-col gap-1 pl-1">{children}</div>}
    </div>
  );
}

export function NodeLibrary({ commands, isLoading }: NodeLibraryProps): React.ReactElement {
  const [search, setSearch] = useState('');

  const categories = useMemo(() => categorizeCommands(commands), [commands]);

  const filteredCategories = useMemo(() => {
    if (!search.trim()) return categories;
    const term = search.toLowerCase();
    return categories
      .map(cat => ({
        ...cat,
        commands: cat.commands.filter(cmd => cmd.name.toLowerCase().includes(term)),
      }))
      .filter(cat => cat.commands.length > 0);
  }, [categories, search]);

  const showQuickNodes =
    !search.trim() ||
    'prompt'.includes(search.toLowerCase()) ||
    'bash'.includes(search.toLowerCase());

  return (
    <div className="flex flex-col h-full overflow-hidden border-r border-border bg-surface">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">
          Node Library
        </h3>
        <input
          type="text"
          value={search}
          onChange={(e): void => {
            setSearch(e.target.value);
          }}
          placeholder="Search..."
          className="w-full rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {isLoading ? (
        <LoadingSkeleton />
      ) : (
        <ScrollArea className="flex-1 overflow-hidden">
          <div className="flex flex-col gap-2 p-2">
            {/* Quick Nodes */}
            {showQuickNodes && (
              <CollapsibleSection title="Quick Nodes" count={2} defaultOpen>
                <DraggableItem type="prompt" name="Prompt" displayName="Prompt" />
                <DraggableItem type="bash" name="Shell" displayName="Bash" />
              </CollapsibleSection>
            )}

            {/* Command categories */}
            {filteredCategories.map(category => (
              <CollapsibleSection
                key={category.name}
                title={category.name}
                count={category.commands.length}
                defaultOpen={category.name === 'Project'}
              >
                {category.commands.map(cmd => (
                  <DraggableItem
                    key={cmd.name}
                    type="command"
                    name={cmd.name}
                    displayName={cmd.name}
                  />
                ))}
              </CollapsibleSection>
            ))}

            {filteredCategories.length === 0 && !showQuickNodes && (
              <p className="text-xs text-text-tertiary px-2 py-4 text-center">No matching nodes</p>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
