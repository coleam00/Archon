import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { createAgent, type AgentDetail, type AgentSource } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TemplateEditorSheet } from './TemplateEditorSheet';

interface CreateAgentDialogProps {
  open: boolean;
  cwd: string | undefined;
  onOpenChange: (open: boolean) => void;
  onCreated: (agent: AgentDetail) => void;
}

const NAME_RE = /^[a-z0-9-]{1,64}$/;

export function CreateAgentDialog({
  open,
  cwd,
  onOpenChange,
  onCreated,
}: CreateAgentDialogProps): React.ReactElement {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState<AgentSource>('project');
  const [templateOpen, setTemplateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => createAgent({ name, source, description, ...(cwd ? { cwd } : {}) }),
    onSuccess: detail => {
      qc.invalidateQueries({ queryKey: ['agents', cwd ?? null] });
      setName('');
      setDescription('');
      onCreated(detail);
    },
    onError: e => {
      setError(e.message);
    },
  });

  function validate(): string | null {
    if (!NAME_RE.test(name)) {
      return 'Name must be 1-64 characters of lowercase letters, digits, or hyphens.';
    }
    if (name === 'claude' || name === 'anthropic' || name.startsWith('_')) {
      return 'That name is reserved.';
    }
    if (description.trim().length === 0) {
      return 'Description is required.';
    }
    return null;
  }

  function handleSubmit(): void {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    mutation.mutate();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>
              Creates <code className="font-mono">.claude/agents/&lt;name&gt;.md</code> seeded from
              the scaffold template.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-[12.5px] font-medium text-bridges-fg1">Name</label>
              <input
                type="text"
                value={name}
                onChange={e => {
                  setName(e.target.value);
                }}
                placeholder="customer-support"
                className="w-full rounded-md border border-bridges-border bg-bridges-surface px-2.5 py-1.5 font-mono text-[12.5px] text-bridges-fg1 placeholder:text-bridges-fg-placeholder focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            <div>
              <label className="mb-1 block text-[12.5px] font-medium text-bridges-fg1">
                Description
              </label>
              <textarea
                value={description}
                onChange={e => {
                  setDescription(e.target.value);
                }}
                rows={2}
                placeholder="Handles customer inquiries, resolves common issues, and escalates when needed."
                className="w-full rounded-md border border-bridges-border bg-bridges-surface px-2.5 py-1.5 text-[12.5px] text-bridges-fg1 placeholder:text-bridges-fg-placeholder focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            <div>
              <label className="mb-1 block text-[12.5px] font-medium text-bridges-fg1">
                Source
              </label>
              <div className="inline-flex rounded-md border border-bridges-border bg-bridges-surface text-[12px]">
                <SourceBtn
                  active={source === 'project'}
                  label="Project"
                  hint=".claude/agents/"
                  onClick={() => {
                    setSource('project');
                  }}
                />
                <SourceBtn
                  active={source === 'global'}
                  label="Global"
                  hint="~/.claude/agents/"
                  onClick={() => {
                    setSource('global');
                  }}
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md border border-bridges-border-subtle bg-bridges-surface-subtle px-3 py-2 text-[12px] text-bridges-fg2">
              <span>
                Seeded from <code className="font-mono">.claude/agents/_templates/default.md</code>
              </span>
              <button
                type="button"
                onClick={() => {
                  setTemplateOpen(true);
                }}
                className="inline-flex items-center gap-1 text-bridges-fg1 hover:underline"
              >
                <Pencil className="h-3 w-3" />
                Edit template
              </button>
            </div>

            {error && (
              <div className="rounded-md bg-bridges-tint-danger-bg px-3 py-2 text-[12px] text-bridges-tint-danger-fg">
                {error}
              </div>
            )}

            <div className="mt-1 flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={handleSubmit} disabled={mutation.isPending}>
                {mutation.isPending ? 'Creating…' : 'Create agent'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {templateOpen && (
        <TemplateEditorSheet
          cwd={cwd}
          onClose={() => {
            setTemplateOpen(false);
          }}
        />
      )}
    </>
  );
}

function SourceBtn({
  active,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}): React.ReactElement {
  let className =
    'flex flex-col items-start px-3 py-1.5 text-left first:rounded-l-md last:rounded-r-md';
  if (active) {
    className += ' bg-bridges-action text-white';
  } else {
    className += ' text-bridges-fg2 hover:bg-bridges-surface-subtle';
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      <span className="text-[12.5px] font-medium leading-tight">{label}</span>
      <span className="font-mono text-[10.5px] opacity-80">{hint}</span>
    </button>
  );
}
