import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { CommandEntry } from '@/lib/api';
import { groupCommandsBySource } from '@/lib/command-groups';
import { useClickOutside } from '@/hooks/useClickOutside';

interface CommandPickerProps {
  commands: CommandEntry[];
  onSelect: (commandName: string) => void;
  onClose: () => void;
}

export function CommandPicker({
  commands,
  onSelect,
  onClose,
}: CommandPickerProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useClickOutside(containerRef, onClose);

  const filteredCommands = searchQuery
    ? commands.filter(cmd => cmd.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : commands;

  const groups = groupCommandsBySource(filteredCommands);

  function toggleGroup(groupName: string): void {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  }

  function handleSelect(commandName: string): void {
    onSelect(commandName);
    onClose();
  }

  return (
    <div
      ref={containerRef}
      className="w-72 max-h-96 bg-surface-elevated border border-border rounded-lg shadow-lg overflow-hidden flex flex-col"
    >
      {/* Search input */}
      <div className="px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-surface-inset border border-border">
          <Search className="size-3.5 text-text-tertiary shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search commands..."
            value={searchQuery}
            onChange={(e): void => {
              setSearchQuery(e.target.value);
            }}
            className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none"
          />
        </div>
      </div>

      {/* Groups */}
      <div className="flex-1 overflow-y-auto py-1">
        {groups.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-text-tertiary">No commands found</div>
        )}

        {groups.map(group => {
          const isCollapsed = collapsedGroups.has(group.source);

          return (
            <div key={group.source}>
              {/* Group header */}
              <button
                type="button"
                onClick={(): void => {
                  toggleGroup(group.source);
                }}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 hover:bg-surface-hover transition-colors cursor-pointer"
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3 text-text-tertiary shrink-0" />
                ) : (
                  <ChevronDown className="size-3 text-text-tertiary shrink-0" />
                )}
                <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide">
                  {group.label}
                </span>
                <span className="text-[10px] text-text-tertiary">({group.commands.length})</span>
              </button>

              {/* Command list */}
              {!isCollapsed &&
                group.commands.map(cmd => (
                  <button
                    key={cmd.name}
                    type="button"
                    onClick={(): void => {
                      handleSelect(cmd.name);
                    }}
                    className="w-full flex items-center gap-2 px-3 pl-7 py-1.5 hover:bg-surface-hover transition-colors cursor-pointer"
                  >
                    {/* No source badge: the group header above IS the source. */}
                    <span className="text-xs text-text-primary truncate flex-1 text-left">
                      {cmd.name}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
