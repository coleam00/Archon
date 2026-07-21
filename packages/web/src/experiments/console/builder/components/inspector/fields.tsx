/**
 * Shared form primitives for the inspector. Token-styled (no shadcn) and
 * deliberately dumb: every value flows up through `onChange`; nothing here
 * touches editor state directly.
 */
import type { ChangeEvent, ReactElement, ReactNode } from 'react';

const INPUT_CLASS =
  'w-full rounded-[8px] border border-border bg-surface px-2 py-1.5 text-[12.5px] text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-accent-bright/60';

export function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
        {label}
      </span>
      {children}
    </label>
  );
}

export function TextField({
  label,
  value,
  placeholder,
  mono = false,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  onChange: (next: string) => void;
}): ReactElement {
  return (
    <Field label={label}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e: ChangeEvent<HTMLInputElement>): void => {
          onChange(e.target.value);
        }}
        className={mono ? `${INPUT_CLASS} font-mono` : INPUT_CLASS}
      />
    </Field>
  );
}

export function TextAreaField({
  label,
  value,
  placeholder,
  rows = 4,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  rows?: number;
  onChange: (next: string) => void;
}): ReactElement {
  return (
    <Field label={label}>
      <textarea
        value={value}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>): void => {
          onChange(e.target.value);
        }}
        className={`${INPUT_CLASS} resize-y font-mono leading-relaxed`}
      />
    </Field>
  );
}

/** Number input; clearing the field reports `undefined` (unset). */
export function NumberField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: number | undefined;
  placeholder?: string;
  onChange: (next: number | undefined) => void;
}): ReactElement {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLInputElement>): void => {
          const raw = e.target.value;
          if (raw === '') {
            onChange(undefined);
            return;
          }
          const parsed = Number(raw);
          if (!Number.isNaN(parsed)) onChange(parsed);
        }}
        className={`${INPUT_CLASS} font-mono`}
      />
    </Field>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): ReactElement {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-0.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e: ChangeEvent<HTMLInputElement>): void => {
          onChange(e.target.checked);
        }}
        className="h-3.5 w-3.5 accent-(--accent-bright)"
      />
      <span className="text-[12.5px] text-text-secondary">{label}</span>
    </label>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (next: string) => void;
}): ReactElement {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(e: ChangeEvent<HTMLSelectElement>): void => {
          onChange(e.target.value);
        }}
        className={INPUT_CLASS}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
