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
 * Console-native chat composer. Auto-growing textarea, Enter sends,
 * Shift+Enter newline, Escape blurs. Click-to-attach files via 📎 (the send
 * skill builds the multipart upload).
 *
 * Reimplemented (not imported) from the old chat's MessageInput because the
 * console may not import production `@/components/**` (ESLint isolation rule).
 *
 * Direction-B `cbox` shell: rounded card with `:focus-within` magenta ring,
 * 📎 attach + decorative `/` lead buttons, gradient `.brand-bar` Send button +
 * glow, kbd-hint row beneath. Attached files render as removable chips above.
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
      className="shrink-0 border-t border-border bg-surface px-[30px] py-[14px]"
      title={disabledReason}
    >
      <div className="mx-auto max-w-[940px]">
        {files.length > 0 ? (
          <div className="mb-[10px] flex flex-wrap gap-[6px]">
            {files.map(f => (
              <span
                key={f.id}
                className="flex items-center gap-[6px] rounded-[8px] border bg-[color:var(--surface-elevated)] py-[4px] pl-[9px] pr-[5px] text-[11.5px]"
                style={{ borderColor: 'var(--border-bright)' }}
              >
                <span className="max-w-[180px] truncate text-text-primary">{f.file.name}</span>
                <span className="font-mono text-[10px] text-text-tertiary">
                  {formatBytes(f.file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    removeFile(f.id);
                  }}
                  aria-label={`Remove ${f.file.name}`}
                  className="rounded p-[1px] text-text-tertiary transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary"
                >
                  <span aria-hidden className="text-[11px] leading-none">
                    ✕
                  </span>
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {fileError !== null ? (
          <div className="mb-[8px] font-mono text-[11px] text-error">{fileError}</div>
        ) : null}
        <div
          className="flex items-end gap-[10px] rounded-[14px] border bg-[color:var(--surface-elevated)] py-[8px] pl-[14px] pr-[8px] transition-[border-color,box-shadow] focus-within:border-[color:color-mix(in_oklch,var(--brand-magenta),transparent_40%)] focus-within:shadow-[0_0_0_4px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          <div className="flex shrink-0 items-end gap-[6px] pb-[7px] text-text-tertiary">
            <button
              type="button"
              onClick={() => {
                fileInputRef.current?.click();
              }}
              aria-label="Attach files"
              disabled={disabled || files.length >= MAX_FILES}
              title="Attach files"
              className="rounded-md p-[3px] transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary disabled:cursor-default disabled:opacity-50"
            >
              📎
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
              className="rounded-md p-[3px] transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary disabled:cursor-default disabled:opacity-50"
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
            className="min-h-0 flex-1 resize-none bg-transparent py-[7px] text-[14.5px] leading-[1.5] text-text-primary placeholder:text-text-tertiary focus:outline-none disabled:opacity-50"
            style={{ maxHeight: `${MAX_HEIGHT.toString()}px` }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={disabled || value.trim().length === 0}
            title="Send · Enter"
            className="brand-bar flex h-[36px] shrink-0 items-center gap-[7px] rounded-[10px] px-[15px] text-[13px] font-bold text-white shadow-[0_6px_18px_-8px_color-mix(in_oklch,var(--brand-magenta),transparent_30%)] transition-[filter,transform] hover:brightness-110 active:translate-y-[1px] disabled:opacity-45 disabled:shadow-none disabled:hover:brightness-100"
          >
            Send
            <span aria-hidden className="font-mono text-[10px] opacity-70">
              ↵
            </span>
          </button>
        </div>
        <div className="mt-[9px] flex items-center justify-between px-[2px] font-mono text-[11px] text-text-tertiary">
          <span />
          <span>
            <span
              className="mr-1 inline-flex items-center rounded border px-[5px] py-[1px] font-mono text-[10.5px] text-text-secondary"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              ↵
            </span>
            send{' '}
            <span
              className="ml-1 inline-flex items-center rounded border px-[5px] py-[1px] font-mono text-[10.5px] text-text-secondary"
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
