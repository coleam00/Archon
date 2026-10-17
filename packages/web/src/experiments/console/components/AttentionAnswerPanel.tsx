import { useState, type MouseEvent, type KeyboardEvent, type ReactElement } from 'react';
import * as skill from '../skills';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import type { Run } from '../primitives/run';

type Attention = Extract<NonNullable<Run['attention']>, { kind: 'attention' }>;

/** True for a wait paused before answers existed; only `resume` continues it. */
export function isLegacyAttention(attention: Attention): boolean {
  return attention.occurrence.startsWith('legacy:');
}

/**
 * Answer a paused attention wait in its declared form: free text for a message, one
 * option for approval and select, one or more for multi_select. The answer names the
 * occurrence it was read at, so the server refuses it if the run has moved on.
 */
export function AttentionAnswerPanel({
  run,
  attention,
}: {
  run: Run;
  attention: Attention;
}): ReactElement | null {
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (isLegacyAttention(attention)) return null;

  const answer = async (choose: string[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (!run.id.startsWith('demo-')) {
        const trimmed = text.trim();
        await skill.answerRun(
          run.id,
          attention.occurrence,
          choose,
          trimmed.length > 0 ? trimmed : undefined
        );
      }
      invalidate('runs');
      invalidate(K.run(run.id));
      setText('');
      setChosen([]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Answer failed.');
    } finally {
      setBusy(false);
    }
  };
  const stopPropagation = (e: MouseEvent | KeyboardEvent): void => {
    e.stopPropagation();
  };
  const button =
    'rounded bg-warning/15 px-2 py-1 text-[12px] font-semibold text-warning hover:bg-warning/25 disabled:opacity-50';

  return (
    <div
      className="mt-2 flex flex-col gap-2 rounded border border-warning/30 bg-warning/[0.06] p-3"
      onClick={stopPropagation}
      onKeyDown={stopPropagation}
    >
      {attention.form === 'multi_select' ? (
        <div className="flex flex-wrap gap-3 text-[12px]">
          {attention.options.map(option => (
            <label key={option.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={chosen.includes(option.id)}
                onChange={event => {
                  setChosen(
                    event.target.checked
                      ? [...chosen, option.id]
                      : chosen.filter(id => id !== option.id)
                  );
                }}
              />
              {option.label ?? option.id}
            </label>
          ))}
        </div>
      ) : null}
      <textarea
        value={text}
        onChange={event => {
          setText(event.target.value);
        }}
        placeholder={attention.form === 'message' ? 'Your answer' : 'Optional text'}
        rows={2}
        className="rounded border border-border bg-surface px-2 py-1 text-[12px] text-text-primary"
      />
      <div className="flex flex-wrap items-center gap-2">
        {attention.form === 'message' || attention.form === 'multi_select' ? (
          <button
            type="button"
            disabled={busy || (attention.form === 'multi_select' && chosen.length === 0)}
            onClick={() => void answer(chosen)}
            className={button}
          >
            {busy ? 'Answering…' : 'Answer'}
          </button>
        ) : (
          attention.options.map(option => (
            <button
              key={option.id}
              type="button"
              disabled={busy}
              onClick={() => void answer([option.id])}
              className={button}
            >
              {option.label ?? option.id}
            </button>
          ))
        )}
        {error !== null ? <span className="font-mono text-[12px] text-error">{error}</span> : null}
      </div>
    </div>
  );
}
