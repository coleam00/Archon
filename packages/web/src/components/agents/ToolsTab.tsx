import { Check, X } from 'lucide-react';
import type { AgentDraft } from './agent-draft';

interface ToolsTabProps {
  draft: AgentDraft;
  onPatch: (patch: Partial<AgentDraft>) => void;
}

const BUILTIN_TOOLS = [
  { name: 'Read', desc: 'Read files from disk' },
  { name: 'Write', desc: 'Create new files' },
  { name: 'Edit', desc: 'Modify existing files' },
  { name: 'Bash', desc: 'Run shell commands' },
  { name: 'Glob', desc: 'Find files by pattern' },
  { name: 'Grep', desc: 'Search file contents' },
  { name: 'WebFetch', desc: 'Fetch and parse URLs' },
  { name: 'WebSearch', desc: 'Search the web' },
  { name: 'Task', desc: 'Delegate to a sub-agent' },
  { name: 'TodoWrite', desc: 'Manage task lists' },
  { name: 'NotebookEdit', desc: 'Edit Jupyter notebooks' },
  { name: 'Skill', desc: 'Invoke an attached skill' },
] as const;

type ToolMode = 'allow' | 'deny' | 'unset';

export function ToolsTab({ draft, onPatch }: ToolsTabProps): React.ReactElement {
  const allowed = new Set(draft.tools);
  const denied = new Set(draft.disallowedTools);
  const granular = draft.tools.filter(t => t.includes('('));
  const customDenied = draft.disallowedTools.filter(t => t.includes('('));

  function modeOf(name: string): ToolMode {
    if (allowed.has(name)) return 'allow';
    if (denied.has(name)) return 'deny';
    return 'unset';
  }

  function setMode(name: string, mode: ToolMode): void {
    let nextTools = draft.tools.filter(t => t !== name);
    let nextDenied = draft.disallowedTools.filter(t => t !== name);
    if (mode === 'allow') nextTools = [...nextTools, name];
    if (mode === 'deny') nextDenied = [...nextDenied, name];
    onPatch({ tools: nextTools, disallowedTools: nextDenied });
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-[15px] font-semibold text-bridges-fg1">Tools</div>
        <div className="mt-1 text-[12.5px] leading-snug text-bridges-fg2">
          Built-in Claude tools the agent may call. Empty = SDK default tools. Allow narrows the
          base set; Deny removes a tool regardless of allow lists.
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-bridges-border-subtle">
        {BUILTIN_TOOLS.map((t, idx) => {
          const mode = modeOf(t.name);
          return (
            <div
              key={t.name}
              className={`flex items-center gap-3 px-3 py-2 ${idx > 0 ? 'border-t border-bridges-border-subtle' : ''}`}
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[12.5px] font-medium text-bridges-fg1">{t.name}</div>
                <div className="text-[11.5px] text-bridges-fg3">{t.desc}</div>
              </div>
              <ToolModeButtons
                mode={mode}
                onChange={m => {
                  setMode(t.name, m);
                }}
              />
            </div>
          );
        })}
      </div>

      <div>
        <div className="text-[12.5px] font-semibold text-bridges-fg1">Granular allow patterns</div>
        <div className="mt-1 text-[11.5px] text-bridges-fg3">
          One per line. Examples: <code className="font-mono">Bash(git:*)</code>,{' '}
          <code className="font-mono">mcp__github__*</code>. Patterns supplement the toggles above.
        </div>
        <textarea
          value={granular.join('\n')}
          onChange={e => {
            const patterns = e.target.value
              .split('\n')
              .map(s => s.trim())
              .filter(Boolean);
            const nonGranular = draft.tools.filter(t => !t.includes('('));
            onPatch({ tools: [...nonGranular, ...patterns] });
          }}
          rows={3}
          className="mt-2 w-full rounded-md border border-bridges-border bg-bridges-surface px-2.5 py-2 font-mono text-[12px] leading-relaxed text-bridges-fg1 focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          placeholder="Bash(git:*)&#10;mcp__github__*"
        />
      </div>

      <div>
        <div className="text-[12.5px] font-semibold text-bridges-fg1">Granular deny patterns</div>
        <div className="mt-1 text-[11.5px] text-bridges-fg3">
          Hard removes the matching tool calls regardless of allow lists.
        </div>
        <textarea
          value={customDenied.join('\n')}
          onChange={e => {
            const patterns = e.target.value
              .split('\n')
              .map(s => s.trim())
              .filter(Boolean);
            const nonGranular = draft.disallowedTools.filter(t => !t.includes('('));
            onPatch({ disallowedTools: [...nonGranular, ...patterns] });
          }}
          rows={2}
          className="mt-2 w-full rounded-md border border-bridges-border bg-bridges-surface px-2.5 py-2 font-mono text-[12px] leading-relaxed text-bridges-fg1 focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          placeholder="Bash(rm:*)"
        />
      </div>
    </div>
  );
}

function ToolModeButtons({
  mode,
  onChange,
}: {
  mode: ToolMode;
  onChange: (m: ToolMode) => void;
}): React.ReactElement {
  return (
    <div className="inline-flex items-center rounded-md border border-bridges-border bg-bridges-surface text-[11.5px]">
      <ToolModeBtn
        label="Auto"
        active={mode === 'unset'}
        onClick={() => {
          onChange('unset');
        }}
      />
      <ToolModeBtn
        label={
          <span className="inline-flex items-center gap-1">
            <Check className="h-2.5 w-2.5" />
            Allow
          </span>
        }
        active={mode === 'allow'}
        onClick={() => {
          onChange('allow');
        }}
      />
      <ToolModeBtn
        label={
          <span className="inline-flex items-center gap-1">
            <X className="h-2.5 w-2.5" />
            Deny
          </span>
        }
        active={mode === 'deny'}
        onClick={() => {
          onChange('deny');
        }}
        danger
      />
    </div>
  );
}

function ToolModeBtn({
  label,
  active,
  onClick,
  danger,
}: {
  label: React.ReactNode;
  active: boolean;
  onClick: () => void;
  danger?: boolean;
}): React.ReactElement {
  let activeBg: string;
  if (active) {
    activeBg = danger
      ? 'bg-bridges-tint-danger-bg text-bridges-tint-danger-fg'
      : 'bg-bridges-action text-white';
  } else {
    activeBg = 'text-bridges-fg2 hover:bg-bridges-surface-subtle';
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-1 first:rounded-l-md last:rounded-r-md ${activeBg}`}
    >
      {label}
    </button>
  );
}
