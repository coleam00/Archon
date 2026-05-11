import { useEffect, useRef, useState, useCallback } from 'react';
import { Box, FileText, Terminal, Zap, Plug, ChevronRight } from 'lucide-react';
import type { CommandEntry } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useClickOutside } from '@/hooks/useClickOutside';
import { CommandPicker } from './CommandPicker';

interface QuickAddPickerProps {
  position: { x: number; y: number };
  onAddNode: (
    type: 'command' | 'prompt' | 'bash',
    options?: { commandName?: string; skills?: string[]; mcp?: string }
  ) => void;
  onClose: () => void;
  commands: CommandEntry[];
}

type SubView = 'main' | 'command' | 'skill' | 'mcp';

export function QuickAddPicker({
  position,
  onAddNode,
  onClose,
  commands,
}: QuickAddPickerProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [subView, setSubView] = useState<SubView>('main');
  const [inputValue, setInputValue] = useState('');

  useClickOutside(containerRef, onClose);

  useEffect(() => {
    if ((subView === 'skill' || subView === 'mcp') && inputRef.current) {
      inputRef.current.focus();
    }
  }, [subView]);

  const handleSubmitInput = useCallback((): void => {
    const val = inputValue.trim();
    if (!val) return;

    if (subView === 'skill') {
      onAddNode('prompt', { skills: [val] });
    } else if (subView === 'mcp') {
      onAddNode('prompt', { mcp: val });
    }
  }, [subView, inputValue, onAddNode]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmitInput();
      } else if (e.key === 'Escape') {
        setSubView('main');
        setInputValue('');
      }
    },
    [handleSubmitInput]
  );

  function handleCommandSelect(commandName: string): void {
    onAddNode('command', { commandName });
  }

  // Command sub-picker
  if (subView === 'command') {
    return (
      <div
        ref={containerRef}
        style={{ position: 'absolute', left: position.x, top: position.y, zIndex: 50 }}
      >
        <CommandPicker commands={commands} onSelect={handleCommandSelect} onClose={onClose} />
      </div>
    );
  }

  // Skill / MCP input sub-view
  if (subView === 'skill' || subView === 'mcp') {
    const isSkill = subView === 'skill';
    return (
      <div
        ref={containerRef}
        style={{ position: 'absolute', left: position.x, top: position.y, zIndex: 50 }}
        className="w-64 bg-surface-elevated border border-border rounded-lg shadow-lg overflow-hidden"
      >
        <div className="px-3 py-2 border-b border-border flex items-center gap-2">
          <button
            type="button"
            onClick={(): void => {
              setSubView('main');
              setInputValue('');
            }}
            className="text-text-tertiary hover:text-text-primary text-xs"
          >
            ←
          </button>
          <span className="text-xs font-medium text-text-secondary">
            {isSkill ? 'Add Skill Node' : 'Add MCP Node'}
          </span>
        </div>
        <div className="p-3">
          <label className="text-[10px] text-text-tertiary block mb-1.5">
            {isSkill ? 'Skill name' : 'MCP config path'}
          </label>
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e): void => {
              setInputValue(e.target.value);
            }}
            onKeyDown={handleInputKeyDown}
            placeholder={isSkill ? 'remotion-best-practices' : '.archon/mcp/ntfy.json'}
            className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary font-mono focus:outline-none focus:border-primary"
          />
          <button
            type="button"
            disabled={!inputValue.trim()}
            onClick={handleSubmitInput}
            className={cn(
              'mt-2 w-full rounded px-3 py-1.5 text-xs font-medium transition-colors',
              inputValue.trim()
                ? 'bg-primary text-white hover:bg-primary/90 cursor-pointer'
                : 'bg-surface border border-border text-text-tertiary cursor-not-allowed'
            )}
          >
            Create Node
          </button>
        </div>
      </div>
    );
  }

  // Main picker menu
  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', left: position.x, top: position.y, zIndex: 50 }}
      className="w-56 bg-surface-elevated border border-border rounded-lg shadow-lg overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-text-secondary">Add Node</span>
      </div>
      <div className="py-1">
        {/* Command */}
        <button
          type="button"
          onClick={(): void => {
            setSubView('command');
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover cursor-pointer"
        >
          <span className="text-text-secondary">
            <Box className="size-4" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-text-primary">Command</div>
            <div className="text-[10px] text-text-tertiary">Run a named command</div>
          </div>
          <ChevronRight className="size-3.5 text-text-tertiary shrink-0" />
        </button>

        {/* Prompt */}
        <button
          type="button"
          onClick={(): void => {
            onAddNode('prompt');
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover cursor-pointer"
        >
          <span className="text-text-secondary">
            <FileText className="size-4" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-text-primary">Prompt</div>
            <div className="text-[10px] text-text-tertiary">Inline AI prompt</div>
          </div>
        </button>

        {/* Bash */}
        <button
          type="button"
          onClick={(): void => {
            onAddNode('bash');
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover cursor-pointer"
        >
          <span className="text-text-secondary">
            <Terminal className="size-4" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-text-primary">Bash</div>
            <div className="text-[10px] text-text-tertiary">Shell script</div>
          </div>
        </button>

        {/* Divider */}
        <div className="my-1 mx-3 border-t border-border" />
        <div className="px-3 py-1">
          <span className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
            Advanced
          </span>
        </div>

        {/* Skill */}
        <button
          type="button"
          onClick={(): void => {
            setSubView('skill');
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover cursor-pointer"
        >
          <span className="text-text-secondary">
            <Zap className="size-4" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-text-primary">Skill</div>
            <div className="text-[10px] text-text-tertiary">Prompt + skill preloading</div>
          </div>
          <ChevronRight className="size-3.5 text-text-tertiary shrink-0" />
        </button>

        {/* MCP */}
        <button
          type="button"
          onClick={(): void => {
            setSubView('mcp');
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-hover cursor-pointer"
        >
          <span className="text-text-secondary">
            <Plug className="size-4" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-text-primary">MCP</div>
            <div className="text-[10px] text-text-tertiary">Prompt + MCP server</div>
          </div>
          <ChevronRight className="size-3.5 text-text-tertiary shrink-0" />
        </button>
      </div>
    </div>
  );
}
