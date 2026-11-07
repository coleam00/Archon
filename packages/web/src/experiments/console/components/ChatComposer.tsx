import { Paperclip } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import {
  ACCEPTED_EXTENSIONS,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_FILE_MB,
  formatBytes,
  isAcceptedFileType,
} from '../primitives/file';

interface ChatComposerProps {
  onSend: (message: string, files?: File[]) => void;
  disabled: boolean;
  disabledReason?: string;
}

const MAX_HEIGHT = 200;

interface PickedFile {
  file: File;
  id: string;
}

/**
 * Auto-growing console chat composer. Enter sends, Shift+Enter inserts a
 * newline, Escape blurs, and the paperclip attaches files for multipart upload.
 * File selection uses the console's local upload limits and validation.
 */
export function ChatComposer({
  onSend,
  disabled,
  disabledReason,
}: ChatComposerProps): ReactElement {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(0);

  const grow = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_HEIGHT);
    el.style.height = `${next.toString()}px`;
    el.style.overflowY = next >= MAX_HEIGHT ? 'auto' : 'hidden';
  };

  const addFiles = (incoming: File[]): void => {
    const next = [...files];
    // Accumulate every rejection reason (not just the last) so a mixed pick
    // surfaces all of them.
    const skipped: string[] = [];
    for (const file of incoming) {
      if (next.length >= MAX_FILES) {
        skipped.push(`${file.name}: over the ${String(MAX_FILES)}-file limit`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        skipped.push(`${file.name}: larger than ${String(MAX_FILE_MB)} MB`);
        continue;
      }
      if (!isAcceptedFileType(file)) {
        skipped.push(`${file.name}: unsupported type`);
        continue;
      }
      next.push({ file, id: String(idRef.current++) });
    }
    setFiles(next);
    setFileError(
      skipped.length > 0
        ? `Skipped ${String(skipped.length)} file(s) — ${skipped.join('; ')}`
        : null
    );
  };

  const removeFile = (id: string): void => {
    setFiles(prev => prev.filter(f => f.id !== id));
    setFileError(null);
  };

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    onSend(trimmed, files.length > 0 ? files.map(f => f.file) : undefined);
    setValue('');
    setFiles([]);
    setFileError(null);
    if (fileInputRef.current !== null) fileInputRef.current.value = '';
    if (textareaRef.current !== null) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Don't submit while an IME composition is in progress (Japanese,
    // Chinese, Korean, etc. — the first Enter accepts a candidate).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape') {
      e.currentTarget.blur();
    }
  };

  return (
    <div
      className="shrink-0 border-t border-border bg-surface px-7.5 py-3.5"
      title={disabledReason}
    >
      <div className="mx-auto max-w-235">
        {files.length > 0 ? (
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {files.map(f => (
              <span
                key={f.id}
                className="flex items-center gap-1.5 rounded-md border bg-[color:var(--surface-elevated)] py-1 pl-2.25 pr-1.25 text-console-12"
                style={{ borderColor: 'var(--border-bright)' }}
              >
                <span className="max-w-45 truncate text-text-primary">{f.file.name}</span>
                <span className="font-mono text-console-10 text-text-tertiary">
                  {formatBytes(f.file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    removeFile(f.id);
                  }}
                  aria-label={`Remove ${f.file.name}`}
                  className="rounded p-px text-text-tertiary transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary"
                >
                  <span aria-hidden className="text-console-11 leading-none">
                    ✕
                  </span>
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {fileError !== null ? (
          <div className="mb-2 font-mono text-console-11 text-error">{fileError}</div>
        ) : null}
        <div
          className="flex items-end gap-2.5 rounded-xl border bg-[color:var(--surface-elevated)] py-2 pl-3.5 pr-2 transition-[border-color,box-shadow] focus-within:border-[color:color-mix(in_oklch,var(--brand-magenta),transparent_40%)] focus-within:shadow-[0_0_0_4px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          <div className="flex shrink-0 items-end gap-1.5 pb-1.75 text-text-tertiary">
            <button
              type="button"
              onClick={() => {
                fileInputRef.current?.click();
              }}
              aria-label="Attach files"
              disabled={disabled || files.length >= MAX_FILES}
              title="Attach files"
              className="flex h-5.5 w-5.5 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary disabled:cursor-default disabled:opacity-50"
            >
              <Paperclip className="h-5 w-5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_EXTENSIONS}
              className="hidden"
              onChange={e => {
                if (e.target.files !== null) addFiles(Array.from(e.target.files));
              }}
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label="Commands"
              disabled
              title="Commands (coming soon)"
              className="flex h-5.5 items-center justify-center rounded-md px-0.5 text-console-17 leading-none transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary disabled:cursor-default disabled:opacity-50"
            >
              /
            </button>
          </div>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={e => {
              setValue(e.target.value);
              grow(e.target);
            }}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={disabled ? (disabledReason ?? 'Waiting…') : 'Message the agent…'}
            className="min-h-0 flex-1 resize-none bg-transparent py-1.75 text-console-15 leading-[1.5] text-text-primary placeholder:text-text-tertiary focus:outline-none disabled:opacity-50"
            style={{ maxHeight: `${MAX_HEIGHT.toString()}px` }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={disabled || value.trim().length === 0}
            title="Send · Enter"
            className="brand-bar flex h-9 shrink-0 items-center gap-1.75 rounded-lg px-3.75 text-console-13 font-bold text-white shadow-[0_6px_18px_-8px_color-mix(in_oklch,var(--brand-magenta),transparent_30%)] transition-[filter,transform] hover:brightness-110 active:translate-y-px disabled:opacity-45 disabled:shadow-none disabled:hover:brightness-100"
          >
            Send
            <span aria-hidden className="font-mono text-console-10 opacity-70">
              ↵
            </span>
          </button>
        </div>
        <div className="mt-2.25 flex items-center justify-between px-0.5 font-mono text-console-11 text-text-tertiary">
          <span />
          <span>
            <span
              className="mr-1 inline-flex items-center rounded border px-1.25 py-px font-mono text-console-11 text-text-secondary"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              ↵
            </span>
            send{' '}
            <span
              className="ml-1 inline-flex items-center rounded border px-1.25 py-px font-mono text-console-11 text-text-secondary"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              ⇧↵
            </span>{' '}
            newline
          </span>
        </div>
      </div>
    </div>
  );
}
