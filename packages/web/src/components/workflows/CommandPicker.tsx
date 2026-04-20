import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { CommandEntry } from '@/lib/api';
import { categorizeCommands } from '@/lib/command-categories';
import { cn } from '@/lib/utils';
import { useClickOutside } from '@/hooks/useClickOutside';
import { commandCategoryLabel, commandSourceLabel, t } from '@/lib/i18n';

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
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useClickOutside(containerRef, onClose);

  const filteredCommands = searchQuery
    ? commands.filter(cmd => cmd.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : commands;

  const categories = categorizeCommands(filteredCommands);

  function toggleCategory(categoryName: string): void {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(categoryName)) {
        next.delete(categoryName);
      } else {
        next.add(categoryName);
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
            placeholder={t('commandPicker.searchCommands')}
            value={searchQuery}
            onChange={(e): void => {
              setSearchQuery(e.target.value);
            }}
            className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none"
          />
        </div>
      </div>

      {/* Categories */}
      <div className="flex-1 overflow-y-auto py-1">
        {categories.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-text-tertiary">
            {t('commandPicker.noCommands')}
          </div>
        )}

        {categories.map(category => {
          const isCollapsed = collapsedCategories.has(category.name);

          return (
            <div key={category.name}>
              {/* Category header */}
              <button
                type="button"
                onClick={(): void => {
                  toggleCategory(category.name);
                }}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 hover:bg-surface-hover transition-colors cursor-pointer"
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3 text-text-tertiary shrink-0" />
                ) : (
                  <ChevronDown className="size-3 text-text-tertiary shrink-0" />
                )}
                <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide">
                  {commandCategoryLabel(category.name)}
                </span>
                <span className="text-[10px] text-text-tertiary">({category.commands.length})</span>
              </button>

              {/* Command list */}
              {!isCollapsed &&
                category.commands.map(cmd => (
                  <button
                    key={cmd.name}
                    type="button"
                    onClick={(): void => {
                      handleSelect(cmd.name);
                    }}
                    className="w-full flex items-center gap-2 px-3 pl-7 py-1.5 hover:bg-surface-hover transition-colors cursor-pointer"
                  >
                    <span className="text-xs text-text-primary truncate flex-1 text-left">
                      {cmd.name}
                    </span>
                    <span
                      className={cn(
                        'text-[9px] font-medium px-1.5 py-0.5 rounded shrink-0',
                        cmd.source === 'project'
                          ? 'bg-node-command/20 text-node-command'
                          : 'bg-surface-inset text-text-tertiary'
                      )}
                    >
                      {commandSourceLabel(cmd.source)}
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
