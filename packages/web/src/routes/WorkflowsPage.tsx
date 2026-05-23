import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus } from 'lucide-react';
import { WorkflowList } from '@/components/workflows/WorkflowList';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function WorkflowsPage(): React.ReactElement {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required.');
      return;
    }
    if (!NAME_PATTERN.test(trimmed)) {
      setError('Use letters, digits, "_", or "-" only (no spaces or path separators).');
      return;
    }
    setOpen(false);
    setName('');
    setError(null);
    navigate(`/workflows/builder?edit=${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h1 className="text-lg font-semibold text-text-primary">Workflows</h1>
        <Dialog
          open={open}
          onOpenChange={(next): void => {
            setOpen(next);
            if (!next) {
              setName('');
              setError(null);
            }
          }}
        >
          <DialogTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
            >
              <Plus className="size-4" />
              New Workflow
            </button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Name your workflow</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <label htmlFor="new-workflow-name" className="text-sm font-medium text-foreground">
                Workflow name
              </label>
              <input
                id="new-workflow-name"
                autoFocus
                value={name}
                placeholder="my-workflow"
                onChange={(e): void => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e): void => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                  }
                }}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
              {error ? (
                <p role="alert" className="text-xs text-error">
                  {error}
                </p>
              ) : (
                <p className="text-xs text-text-secondary">
                  Becomes the YAML filename. You can rename it later in the toolbar.
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={(): void => {
                  setOpen(false);
                }}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90"
              >
                Create
              </button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <div className="flex-1 overflow-hidden px-4 pb-0 pt-2">
        <WorkflowList />
      </div>
    </div>
  );
}
