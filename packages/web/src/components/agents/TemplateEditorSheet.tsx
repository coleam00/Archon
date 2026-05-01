import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { getAgentTemplate, saveAgentTemplate, type AgentTemplateResponse } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

interface TemplateEditorSheetProps {
  cwd: string | undefined;
  onClose: () => void;
}

export function TemplateEditorSheet({
  cwd,
  onClose,
}: TemplateEditorSheetProps): React.ReactElement {
  const qc = useQueryClient();
  const [content, setContent] = useState<string>('');

  const { data, isLoading, isError, error } = useQuery<AgentTemplateResponse>({
    queryKey: ['agent-template', cwd ?? null],
    queryFn: () => getAgentTemplate(cwd),
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (data) setContent(data.content);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => saveAgentTemplate(content, cwd),
    onSuccess: result => {
      qc.invalidateQueries({ queryKey: ['agent-template', cwd ?? null] });
      qc.setQueryData<AgentTemplateResponse>(['agent-template', cwd ?? null], prev =>
        prev ? { ...prev, path: result.path, source: result.source, preExisting: true } : prev
      );
    },
  });

  return (
    <Sheet
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="w-[640px] sm:max-w-[640px]">
        <SheetHeader>
          <SheetTitle>Edit scaffold template</SheetTitle>
          <SheetDescription>
            Every new agent is seeded from this template.{' '}
            <code className="font-mono">TEMPLATE_AGENT_NAME</code> is replaced with the new agent's
            name; the description placeholder is replaced with the user's input.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex flex-col gap-3">
          {isLoading && <div className="text-[12.5px] text-bridges-fg3">Loading template…</div>}
          {isError && (
            <div className="text-[12.5px] text-bridges-tint-danger-fg">
              Failed to load template: {(error as Error | undefined)?.message}
            </div>
          )}
          {data && (
            <>
              <div className="rounded-md border border-bridges-border-subtle bg-bridges-surface-subtle px-3 py-2 text-[11.5px] text-bridges-fg3">
                File: <code className="font-mono">{data.path}</code>{' '}
                <span className="ml-1 inline-flex items-center rounded bg-bridges-surface-muted px-1.5 py-px text-[10.5px] text-bridges-fg2">
                  {data.source}
                </span>
              </div>
              <textarea
                value={content}
                onChange={e => {
                  setContent(e.target.value);
                }}
                rows={20}
                className="w-full rounded-md border border-bridges-border bg-bridges-surface px-2.5 py-2 font-mono text-[12px] leading-relaxed text-bridges-fg1 focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={onClose}>
                  Close
                </Button>
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    saveMutation.mutate();
                  }}
                  disabled={saveMutation.isPending || content === data.content}
                >
                  <Save className="h-3.5 w-3.5" />
                  {saveMutation.isPending ? 'Saving…' : 'Save template'}
                </Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
