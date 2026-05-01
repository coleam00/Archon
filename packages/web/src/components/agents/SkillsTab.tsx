import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Sparkles, X } from 'lucide-react';
import { listSkills, type SkillSummary } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { AgentDraft } from './agent-draft';

interface SkillsTabProps {
  draft: AgentDraft;
  cwd: string | undefined;
  onPatch: (patch: Partial<AgentDraft>) => void;
}

export function SkillsTab({ draft, cwd, onPatch }: SkillsTabProps): React.ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['skills', cwd ?? null],
    queryFn: () => listSkills(cwd),
    refetchOnWindowFocus: false,
  });
  const allSkills = data?.skills ?? [];
  const skillByName = new Map(allSkills.map(s => [s.name, s]));

  function add(skill: SkillSummary): void {
    if (draft.skills.includes(skill.name)) return;
    onPatch({ skills: [...draft.skills, skill.name] });
    setPickerOpen(false);
  }

  function remove(name: string): void {
    onPatch({ skills: draft.skills.filter(s => s !== name) });
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-[15px] font-semibold text-bridges-fg1">Skills</div>
        <div className="mt-1 text-[12.5px] leading-snug text-bridges-fg2">
          Skills are step-by-step playbooks the agent uses for specific tasks. The model picks the
          right one based on the user's request.
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {draft.skills.map(name => {
          const skill = skillByName.get(name);
          return (
            <div
              key={name}
              className="flex items-center gap-3 rounded-md border border-bridges-border-subtle bg-bridges-surface px-3 py-2"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bridges-surface-muted text-bridges-fg2">
                <Sparkles className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-bridges-fg1">{name}</div>
                {skill?.description && (
                  <div className="truncate text-[12px] text-bridges-fg3">{skill.description}</div>
                )}
                {!skill && (
                  <div className="text-[12px] text-bridges-tint-warning-fg">
                    Skill not found in registry
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  remove(name);
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-bridges-fg3 hover:bg-bridges-surface-muted"
                aria-label={`Remove ${name}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
        {draft.skills.length === 0 && (
          <div className="rounded-md border border-dashed border-bridges-border px-4 py-6 text-center text-[12.5px] text-bridges-fg3">
            No skills assigned yet.
          </div>
        )}
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setPickerOpen(true);
        }}
        className="w-fit gap-1.5 text-[12.5px]"
      >
        <Plus className="h-3.5 w-3.5" />
        Add skill
      </Button>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add skill</DialogTitle>
            <DialogDescription>
              Pick a skill from the registry to give this agent.
            </DialogDescription>
          </DialogHeader>
          <SkillPicker skills={allSkills} taken={new Set(draft.skills)} onPick={add} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SkillPicker({
  skills,
  taken,
  onPick,
}: {
  skills: SkillSummary[];
  taken: Set<string>;
  onPick: (skill: SkillSummary) => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const filtered = skills.filter(s => {
    if (taken.has(s.name)) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  });

  return (
    <div className="flex flex-col gap-2">
      <input
        type="text"
        value={query}
        onChange={e => {
          setQuery(e.target.value);
        }}
        placeholder="Search skills"
        className="w-full rounded-md border border-bridges-border bg-bridges-surface px-2.5 py-1.5 text-[13px] text-bridges-fg1 placeholder:text-bridges-fg-placeholder focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
      />
      <div className="max-h-72 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-[12.5px] text-bridges-fg3">
            {taken.size === skills.length ? 'All skills already added.' : 'No matching skills.'}
          </div>
        )}
        {filtered.map(s => (
          <button
            key={`${s.source}:${s.name}`}
            type="button"
            onClick={() => {
              onPick(s);
            }}
            className="flex w-full items-center gap-3 rounded px-2 py-2 text-left hover:bg-bridges-surface-subtle"
          >
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-bridges-surface-muted text-bridges-fg2">
              <Sparkles className="h-3 w-3" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-bridges-fg1">{s.name}</div>
              {s.description && (
                <div className="truncate text-[11.5px] text-bridges-fg3">{s.description}</div>
              )}
            </div>
            <span className="font-mono text-[10.5px] text-bridges-fg3">{s.source}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
