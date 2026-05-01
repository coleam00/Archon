import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  readSkillFileText,
  skillFileUrl,
  uploadSkillFile,
  writeSkillFileText,
  type SkillSource,
} from '@/lib/api';
import { isImageFile, isTextFile } from '@/lib/skill-utils';
import { Upload } from 'lucide-react';

interface SkillFileEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skillName: string;
  source: SkillSource;
  cwd: string | undefined;
  /** Relative path inside the skill directory, e.g. "scripts/foo.sh". */
  filePath: string | null;
}

export function SkillFileEditor({
  open,
  onOpenChange,
  skillName,
  source,
  cwd,
  filePath,
}: SkillFileEditorProps): React.ReactElement {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string>('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const isText = filePath ? isTextFile(filePath) : false;
  const isImage = filePath ? isImageFile(filePath) : false;

  const { data: textContent, isLoading: textLoading } = useQuery({
    enabled: open && !!filePath && isText,
    queryKey: ['skill-file-text', skillName, source, cwd ?? null, filePath],
    queryFn: () => readSkillFileText(skillName, source, filePath ?? '', cwd),
  });

  useEffect(() => {
    if (textContent !== undefined) setDraft(textContent);
  }, [textContent]);

  const dirty = isText && textContent !== undefined && draft !== textContent;

  const saveMutation = useMutation({
    mutationFn: () => writeSkillFileText(skillName, source, filePath ?? '', draft, cwd),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['skill', skillName, source, cwd ?? null] });
      void queryClient.invalidateQueries({
        queryKey: ['skill-file-text', skillName, source, cwd ?? null, filePath],
      });
      setSaveError(null);
    },
    onError: err => {
      setSaveError(err.message);
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadSkillFile(skillName, source, filePath ?? '', file, cwd),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['skill', skillName, source, cwd ?? null] });
      setUploadError(null);
    },
    onError: err => {
      setUploadError(err.message);
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full max-w-2xl flex-col gap-0 border-bridges-border bg-bridges-surface p-0 sm:max-w-2xl"
      >
        <SheetHeader className="border-b border-bridges-border-subtle px-5 py-3">
          <SheetTitle className="font-mono text-[13px] font-medium text-bridges-fg1">
            {filePath ?? '—'}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-5">
          {!filePath && (
            <div className="text-center text-[13px] text-bridges-fg3">No file selected.</div>
          )}

          {filePath && isText && (
            <>
              {textLoading ? (
                <div className="text-[13px] text-bridges-fg3">Loading…</div>
              ) : (
                <textarea
                  value={draft}
                  onChange={e => {
                    setDraft(e.target.value);
                  }}
                  spellCheck={false}
                  className="h-[60vh] w-full resize-y rounded-md border border-bridges-border bg-bridges-surface p-3 font-mono text-[12.5px] leading-relaxed text-bridges-fg1 focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              )}
            </>
          )}

          {filePath && isImage && (
            <div className="flex flex-col items-start gap-3">
              <img
                src={skillFileUrl(skillName, source, filePath, cwd)}
                alt={filePath}
                className="max-h-[50vh] max-w-full rounded-md border border-bridges-border bg-white object-contain"
              />
              <ReplaceUpload
                onPick={file => {
                  setUploadError(null);
                  uploadMutation.mutate(file);
                }}
                disabled={uploadMutation.isPending}
              />
              {uploadError && (
                <div className="text-[12px] text-bridges-tint-danger-fg">{uploadError}</div>
              )}
            </div>
          )}

          {filePath && !isText && !isImage && (
            <div className="flex flex-col items-start gap-3">
              <div className="rounded-md border border-bridges-border bg-bridges-surface-subtle px-3 py-2 text-[12.5px] text-bridges-fg2">
                Binary file — preview not supported. You can replace it via upload.
              </div>
              <ReplaceUpload
                onPick={file => {
                  setUploadError(null);
                  uploadMutation.mutate(file);
                }}
                disabled={uploadMutation.isPending}
              />
              {uploadError && (
                <div className="text-[12px] text-bridges-tint-danger-fg">{uploadError}</div>
              )}
            </div>
          )}
        </div>

        {filePath && isText && (
          <div className="flex items-center justify-end gap-2 border-t border-bridges-border-subtle px-5 py-3">
            {saveError && (
              <div className="mr-auto text-[12px] text-bridges-tint-danger-fg">{saveError}</div>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                if (textContent !== undefined) setDraft(textContent);
              }}
              disabled={!dirty || saveMutation.isPending}
            >
              Reset
            </Button>
            <Button
              onClick={() => {
                setSaveError(null);
                saveMutation.mutate();
              }}
              disabled={!dirty || saveMutation.isPending}
            >
              {saveMutation.isPending ? 'Saving…' : 'Save file'}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ReplaceUpload({
  onPick,
  disabled,
}: {
  onPick: (file: File) => void;
  disabled: boolean;
}): React.ReactElement {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-bridges-border bg-bridges-surface px-3 py-1.5 text-[12.5px] font-medium text-bridges-fg1 hover:bg-bridges-surface-subtle">
      <Upload className="h-3.5 w-3.5" />
      Replace file
      <input
        type="file"
        className="hidden"
        disabled={disabled}
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = '';
        }}
      />
    </label>
  );
}
