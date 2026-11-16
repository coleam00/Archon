import { useState, type MouseEvent, type KeyboardEvent, type ReactElement } from 'react';
import * as skill from '../skills';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import type { ItemAsk, Run } from '../primitives/run';

type Attention = Extract<NonNullable<Run['attention']>, { kind: 'attention' }>;

/**
 * What an answer form renders, shared by a paused run's wait and an ask a completed run
 * left; only an ask's options carry a cost.
 */
export type AnswerFields = Pick<ItemAsk, 'form' | 'options' | 'other' | 'recommendation'>;

/** True for a wait paused before answers existed; only `resume` continues it. */
export function isLegacyAttention(attention: Attention): boolean {
  return attention.occurrence.startsWith('legacy:');
}

/**
 * The reserved option of a wait declared with `other: true` is answered with text. The
 * engine adds it after the declared options, so the flag names it without its id.
 */
function needsText(fields: AnswerFields, optionId: string, text: string): boolean {
  return fields.other === true && optionId === fields.options.at(-1)?.id && text.trim() === '';
}

function textPlaceholder(fields: AnswerFields): string {
  if (fields.form === 'message') return 'Your answer';
  return fields.other === true ? 'Optional text; required for Other' : 'Optional text';
}

/**
 * Answer a paused attention wait in its declared form. The answer names the occurrence it
 * was read at, so the server refuses it if the run has moved on.
 */
export function AttentionAnswerPanel({
  run,
  attention,
}: {
  run: Run;
  attention: Attention;
}): ReactElement | null {
  if (isLegacyAttention(attention)) return null;
  const submit = async (choose: string[], text: string | undefined): Promise<void> => {
    if (!run.id.startsWith('demo-'))
      await skill.answerRun(run.id, attention.occurrence, choose, text);
    invalidate('runs');
    invalidate(K.run(run.id));
  };
  return <AttentionAnswerForm fields={attention} submit={submit} />;
}

/**
 * An answer in the declared form: free text for a message, one option for approval and
 * select, one or more for multi_select. Options keep the order they are listed in. With a
 * `refusal`, the options and recommendation are shown with the reason and no controls.
 */
export function AttentionAnswerForm({
  fields,
  submit,
  refusal,
}: {
  fields: AnswerFields;
  submit: (choose: string[], text: string | undefined) => Promise<void>;
  refusal?: string;
}): ReactElement {
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (choose: string[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const trimmed = text.trim();
      await submit(choose, trimmed.length > 0 ? trimmed : undefined);
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
    'rounded bg-warning/15 px-2 py-1 text-console-12 font-semibold text-warning hover:bg-warning/25 disabled:opacity-50';
  const { recommendation } = fields;

  return (
    <div
      className="mt-2 flex flex-col gap-2 rounded border border-warning/30 bg-warning/[0.06] p-3"
      onClick={stopPropagation}
      onKeyDown={stopPropagation}
    >
      <AnswerSummary fields={fields} />
      {refusal !== undefined ? (
        <p className="text-console-12 text-text-secondary">You can't answer this: {refusal}</p>
      ) : (
        <>
          {fields.form === 'multi_select' ? (
            <div className="flex flex-wrap gap-3 text-console-12">
              {fields.options.map(option => (
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
            placeholder={textPlaceholder(fields)}
            rows={2}
            className="rounded border border-border bg-surface px-2 py-1 text-console-12 text-text-primary"
          />
          <div className="flex flex-wrap items-center gap-2">
            {fields.form === 'message' || fields.form === 'multi_select' ? (
              <button
                type="button"
                disabled={busy || (fields.form === 'multi_select' && chosen.length === 0)}
                onClick={() => void answer(chosen)}
                className={button}
              >
                {busy ? 'Answering…' : 'Answer'}
              </button>
            ) : (
              fields.options.map(option => (
                <button
                  key={option.id}
                  type="button"
                  disabled={busy || needsText(fields, option.id, text)}
                  onClick={() => void answer([option.id])}
                  className={
                    recommendation?.option === option.id ? `${button} ring-1 ring-warning` : button
                  }
                >
                  {`${option.label ?? option.id}${recommendation?.option === option.id ? ' (recommended)' : ''}`}
                </button>
              ))
            )}
            {error !== null ? (
              <span className="font-mono text-console-12 text-error">{error}</span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/** The recommendation and what each option does and costs, in the order they are listed. */
function AnswerSummary({ fields }: { fields: AnswerFields }): ReactElement {
  const { recommendation } = fields;
  const optionName = (id: string): string =>
    fields.options.find(option => option.id === id)?.label ?? id;
  const described = fields.options.filter(
    option => option.does !== undefined || option.cost !== undefined
  );
  return (
    <>
      {recommendation !== undefined ? (
        <p className="text-console-12 text-text-primary">
          <span className="font-semibold">Recommended: {optionName(recommendation.option)}</span>
          {recommendation.confidence !== undefined
            ? ` (${recommendation.confidence} confidence)`
            : ''}
          . {recommendation.why}
        </p>
      ) : null}
      {described.length > 0 ? (
        <ul className="flex flex-col gap-1 text-console-12 text-text-secondary">
          {described.map(option => (
            <li key={option.id}>
              <span className="font-semibold text-text-primary">{option.label ?? option.id}</span>
              {option.does !== undefined ? `: ${option.does}` : ''}
              {option.cost !== undefined ? (
                <span className="text-text-tertiary"> Cost: {option.cost}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
