import { useState, useEffect, useMemo, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listWorkflows } from '@/lib/api';
import { useProject } from '@/contexts/ProjectContext';

interface SlashCommandMenuProps {
  query: string;
  onSelect: (command: string) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLTextAreaElement | null>;
}

export function SlashCommandMenu({
  query,
  onSelect,
  onClose,
  anchorRef,
}: SlashCommandMenuProps): React.ReactElement | null {
  const { selectedProjectId, codebases } = useProject();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuMaxHeight, setMenuMaxHeight] = useState(256);

  const cwd = selectedProjectId
    ? codebases?.find(cb => cb.id === selectedProjectId)?.default_cwd
    : undefined;

  const { data: workflows } = useQuery({
    queryKey: ['workflows', cwd ?? null],
    queryFn: () => listWorkflows(cwd),
    staleTime: 30_000,
  });

  const filtered = useMemo(
    () =>
      (workflows ?? [])
        .filter((entry) =>
          entry.workflow.name.toLowerCase().includes(query.toLowerCase())
        )
        .slice(0, 8),
    [workflows, query]
  );

  // Reset selected index when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Use anchorRef to compute available vertical space above the textarea
  useEffect(() => {
    const textarea = anchorRef.current;
    if (!textarea) return;

    const update = (): void => {
      const rect = textarea.getBoundingClientRect();
      setMenuMaxHeight(Math.min(256, Math.max(80, rect.top - 16)));
    };

    update();
    window.addEventListener('resize', update);
    return (): void => {
      window.removeEventListener('resize', update);
    };
  }, [anchorRef]);

  // Keyboard navigation — capture phase so this fires before the textarea keydown handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (filtered.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const entry = filtered[selectedIndex];
        if (entry) {
          onSelect(entry.workflow.name);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return (): void => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [filtered, selectedIndex, onSelect, onClose]);

  if (filtered.length === 0) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 z-50 mb-1 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg"
      style={{ maxHeight: `${menuMaxHeight}px` }}
      aria-activedescendant={`slash-option-${selectedIndex}`}
            role="listbox"
      aria-label="Workflow commands"
    >
      {filtered.map((entry, idx) => (
        <button
          id={`slash-option-${idx}`}
                key={entry.workflow.name}
          type="button"
          role="option"
          aria-selected={idx === selectedIndex}
          onClick={(): void => {
            onSelect(entry.workflow.name);
          }}
          onMouseEnter={(): void => {
            setSelectedIndex(idx);
          }}
          className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors${
            idx === selectedIndex ? ' bg-surface-elevated' : ' hover:bg-surface-elevated'
          }`}
        >
          <span className="font-mono text-sm text-primary">{`/${entry.workflow.name}`}</span>
          {entry.workflow.description && (
            <span className="truncate text-xs text-muted-foreground">
              {entry.workflow.description}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
