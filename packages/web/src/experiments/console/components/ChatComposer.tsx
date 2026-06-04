import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

interface ChatComposerProps {
  onSend: (message: string) => void;
  disabled: boolean;
  disabledReason?: string;
}

const MAX_HEIGHT = 200;

/**
 * Console-native chat composer. Auto-growing textarea, Enter sends,
 * Shift+Enter newline, Escape blurs. Text-only for the MVP — file attachment
 * (sendMessage already supports `files`) is a deferred enhancement.
 *
 * Reimplemented (not imported) from the old chat's MessageInput because the
 * console may not import production `@/components/**` (ESLint isolation rule).
 */
export function ChatComposer({
  onSend,
  disabled,
  disabledReason,
}: ChatComposerProps): ReactElement {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const grow = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_HEIGHT);
    el.style.height = `${next.toString()}px`;
    el.style.overflowY = next >= MAX_HEIGHT ? 'auto' : 'hidden';
  };

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    onSend(trimmed);
    setValue('');
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
    <div className="shrink-0 border-t border-border bg-surface px-6 py-3" title={disabledReason}>
      <div className="flex items-end gap-2">
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
          className="min-h-[40px] flex-1 resize-none rounded border border-border bg-surface-inset px-3 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none disabled:opacity-50"
          style={{ maxHeight: `${MAX_HEIGHT.toString()}px` }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || value.trim().length === 0}
          title="Send · Enter"
          className="flex h-9 shrink-0 items-center gap-1 rounded border border-accent-bright/40 bg-accent-bright/15 px-3 text-[12px] font-medium text-accent-bright transition-colors hover:bg-accent-bright/25 disabled:opacity-40"
        >
          Send
          <span aria-hidden className="font-mono text-[10px] opacity-70">
            ↵
          </span>
        </button>
      </div>
    </div>
  );
}
