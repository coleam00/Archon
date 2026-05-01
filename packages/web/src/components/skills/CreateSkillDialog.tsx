import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { createSkill, type SkillDetail, type SkillSource } from '@/lib/api';
import { validateSkillNameClient } from '@/lib/skill-utils';
import { cn } from '@/lib/utils';

interface CreateSkillDialogProps {
  open: boolean;
  cwd: string | undefined;
  onOpenChange: (open: boolean) => void;
  onCreated: (skill: SkillDetail) => void;
}

const STARTER_BODY = `# Skill instructions

Describe what this skill does and the steps Claude should follow.

## When to use

## Steps

1. ...
`;

export function CreateSkillDialog({
  open,
  cwd,
  onOpenChange,
  onCreated,
}: CreateSkillDialogProps): React.ReactElement {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState<SkillSource>('global');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Reset on open
  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setSource('global');
      setSubmitError(null);
    }
  }, [open]);

  const createMutation = useMutation({
    mutationFn: () =>
      createSkill({
        name: name.trim(),
        source,
        cwd,
        frontmatter: { name: name.trim(), description: description.trim() },
        body: STARTER_BODY,
      }),
    onSuccess: detail => {
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      onCreated(detail);
    },
    onError: err => {
      setSubmitError(err.message);
    },
  });

  const nameError = name ? validateSkillNameClient(name.trim()) : null;
  const descLen = description.length;
  const descError =
    description.trim() === '' ? 'Description is required' : descLen > 1024 ? 'Too long' : null;
  const canSubmit =
    nameError === null && descError === null && name.trim() !== '' && !createMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-xl border-bridges-border bg-bridges-surface p-6 text-bridges-fg1">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold">New skill</DialogTitle>
          <DialogDescription className="text-[13px] leading-snug text-bridges-fg2">
            Skills live as <code className="font-mono text-[12px]">{'<name>/SKILL.md'}</code> with
            YAML frontmatter and a markdown body.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field label="Name" hint={nameError ?? 'Lowercase letters, digits, hyphens. Max 64.'}>
            <input
              type="text"
              value={name}
              onChange={e => {
                setName(e.target.value);
              }}
              autoFocus
              spellCheck={false}
              placeholder="my-skill-name"
              className={cn(
                'w-full rounded-md border bg-bridges-surface px-3 py-2 font-mono text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500/20',
                nameError
                  ? 'border-bridges-tint-danger-fg'
                  : 'border-bridges-border focus:border-bridges-border-strong'
              )}
            />
          </Field>

          <Field
            label="Description"
            hint={descError ?? `${descLen.toString()}/1024 characters — used for skill discovery.`}
          >
            <textarea
              value={description}
              onChange={e => {
                setDescription(e.target.value);
              }}
              rows={3}
              placeholder="When to use this skill, and what it does."
              className={cn(
                'w-full resize-y rounded-md border bg-bridges-surface px-3 py-2 text-[13px] leading-snug focus:outline-none focus:ring-2 focus:ring-blue-500/20',
                descError
                  ? 'border-bridges-tint-danger-fg'
                  : 'border-bridges-border focus:border-bridges-border-strong'
              )}
            />
          </Field>

          <Field label="Scope">
            <div className="inline-flex rounded-md border border-bridges-border bg-bridges-surface p-0.5">
              <ScopeButton
                label="Global"
                description="~/.claude/skills/"
                active={source === 'global'}
                onClick={() => {
                  setSource('global');
                }}
              />
              <ScopeButton
                label="Project"
                description=".claude/skills/"
                active={source === 'project'}
                onClick={() => {
                  setSource('project');
                }}
              />
            </div>
          </Field>

          {submitError && (
            <div className="rounded-md border border-bridges-tint-danger-fg/30 bg-bridges-tint-danger-bg px-3 py-2 text-[12.5px] text-bridges-tint-danger-fg">
              {submitError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!canSubmit}
              onClick={() => {
                setSubmitError(null);
                createMutation.mutate();
              }}
            >
              {createMutation.isPending ? 'Creating…' : 'Create skill'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-semibold text-bridges-fg1">{label}</label>
      {children}
      {hint && <div className="text-[11.5px] leading-snug text-bridges-fg3">{hint}</div>}
    </div>
  );
}

function ScopeButton({
  label,
  description,
  active,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col rounded-md px-3 py-1.5 text-left transition-colors',
        active ? 'bg-bridges-action text-white' : 'text-bridges-fg2 hover:bg-bridges-surface-subtle'
      )}
    >
      <span className="text-[12.5px] font-medium leading-tight">{label}</span>
      <span
        className={cn(
          'mt-0.5 font-mono text-[10.5px]',
          active ? 'text-white/80' : 'text-bridges-fg3'
        )}
      >
        {description}
      </span>
    </button>
  );
}
