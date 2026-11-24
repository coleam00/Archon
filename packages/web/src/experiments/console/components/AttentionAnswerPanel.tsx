import { useState, type MouseEvent, type KeyboardEvent, type ReactElement } from 'react';
import {
  answerProblem,
  isOtherOption,
  optionLabel,
  pickOption,
  recommendationWhy,
  recommendedLabel,
  takesText,
  tileOrder,
  type AttentionWait,
} from '../lib/ask-card';
import { offeredPlaceholder, type Offered } from '../lib/ask-offered';
import { errorDetail } from '../lib/http';
import * as skill from '../skills';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import type { Run } from '../primitives/run';
import { AskConfirm, type ConfirmDraft } from './ask-card/AskConfirm';
import { AskTiles, type AskTile } from './ask-card/AskTiles';

type Attention = Extract<NonNullable<Run['attention']>, { kind: 'attention' }>;

/** Sends a chosen answer; throws the server's refusal. */
type SubmitAnswer = (choose: string[], text: string | undefined) => Promise<void>;

/**
 * True for a wait paused before answers existed; only `resume` continues it. Takes the
 * occurrence alone so a run's attention and a queue item's run share this one check.
 */
export function isLegacyAttention(attention: { occurrence: string }): boolean {
  return attention.occurrence.startsWith('legacy:');
}

/**
 * Answer a queue item by its ref, then refresh every `runs` key (the project's queue, which
 * the answered item leaves, and the runs feed the answer moved on) and every `factory-items`
 * key (an item page lists the answer among its answers). A refusal refreshes too: it usually
 * means the item closed, so the stale card should go.
 */
export function answerByRef(ref: string): SubmitAnswer {
  return async (choose, text) => {
    try {
      await skill.answerAttentionItem(ref, { choose, ...(text === undefined ? {} : { text }) });
    } finally {
      invalidate('runs');
      invalidate('factory-items');
    }
  };
}

function tilesOf(
  wait: AttentionWait,
  starts: ((optionId: string) => string | undefined) | undefined
): AskTile[] {
  return tileOrder(wait).map(option => {
    const started = starts?.(option.id);
    return {
      id: option.id,
      label: optionLabel(wait, option),
      ...(started === undefined ? {} : { starts: started }),
      ...(option.does === undefined ? {} : { does: option.does }),
      ...(option.cost === undefined ? {} : { cost: option.cost }),
      recommended: option.id === wait.recommendation?.option,
      other: isOtherOption(wait, option.id),
    };
  });
}

/**
 * What the confirm row asks for, given the picks so far. While the card shows what the stage
 * offered, a pick's optional note asks which of those is meant, on every tile: the routes are
 * the pack's, and the console names none of them (rule 1). An answer in words keeps its own
 * prompt, and whether text is required does not change.
 */
function draftOf(
  wait: AttentionWait,
  tiles: readonly AskTile[],
  picks: readonly string[],
  offered: Offered | null
): ConfirmDraft {
  const labels = picks.map(id => tiles.find(tile => tile.id === id)?.label ?? id);
  if (wait.form === 'message') return { labels, text: 'required', placeholder: 'Your answer' };
  if (takesText(wait, picks))
    return { labels, text: 'required', placeholder: 'Say what to do instead' };
  const placeholder =
    offered === null ? 'Optional note with your answer' : offeredPlaceholder(offered);
  return { labels, text: 'optional', placeholder };
}

/**
 * Answer a paused attention wait in its declared form, as the ask card draws it (DESIGN.md,
 * Visual standard rule 9): one tile per option, the recommended one first and marked with
 * why; choosing a tile (or several, for multi_select) opens the confirm row, and Confirm
 * sends. An answer only in words has no tiles and opens with the textarea. Confirm is enabled
 * when the engine would accept the answer (`answerProblem`), and for an answer only in words
 * only once its text has a non-blank character, which the engine does not require. `submit` sends; a
 * refusal shows in the server's own words. `onAnswered` hears the chosen words once sent.
 * `offered`, from the ask card, is what the stage offered in its own words (`parseOffered`).
 * `starts` gives what choosing an option starts, in the factory view's words, and
 * `unrecommended` why a stage that left the ask could not choose (`unrecommendedOf`).
 */
export function AttentionAnswerForm({
  wait,
  submit,
  onAnswered,
  offered = null,
  starts,
  unrecommended,
  refusal,
}: {
  wait: AttentionWait;
  submit: SubmitAnswer;
  onAnswered?: (label: string) => void;
  offered?: Offered | null;
  starts?: (optionId: string) => string | undefined;
  unrecommended?: string;
  /** The server's reason the caller may not answer: the options show, with no way to choose. */
  refusal?: string;
}): ReactElement {
  const [picks, setPicks] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tiles = tilesOf(wait, starts);
  const draft = draftOf(wait, tiles, picks, offered);
  const open = refusal === undefined && (wait.form === 'message' || picks.length > 0);

  const reset = (): void => {
    setPicks([]);
    setText('');
    setError(null);
  };
  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const trimmed = text.trim();
      await submit(picks, trimmed.length > 0 ? trimmed : undefined);
      reset();
      onAnswered?.(draft.labels.length > 0 ? draft.labels.join(', ') : 'in words');
    } catch (e: unknown) {
      setError(errorDetail(e));
    } finally {
      setBusy(false);
    }
  };
  // The card can sit inside a clickable run card; a choice made here must not open the run.
  const stopPropagation = (e: MouseEvent | KeyboardEvent): void => {
    e.stopPropagation();
  };
  return (
    <div className="flex flex-col gap-3" onClick={stopPropagation} onKeyDown={stopPropagation}>
      {wait.form === 'message' ? null : (
        <AskTiles
          tiles={tiles}
          picks={picks}
          disabled={busy || refusal !== undefined}
          onPick={id => {
            setPicks(pickOption(wait, picks, id));
            setError(null);
          }}
        />
      )}
      <RecommendationWhy wait={wait} unrecommended={unrecommended} />
      {refusal === undefined ? null : (
        <p className="text-console-13 text-text-secondary">You can't answer this: {refusal}</p>
      )}
      {open ? (
        <AskConfirm
          draft={draft}
          value={text}
          onChange={setText}
          accepted={
            answerProblem(wait, { choose: picks, text }) === undefined &&
            !(wait.form === 'message' && text.trim() === '')
          }
          busy={busy}
          error={error}
          onConfirm={() => void confirm()}
          {...(wait.form === 'message' ? {} : { onCancel: reset })}
        />
      ) : null}
    </div>
  );
}

/**
 * One line under the tiles: why the recommended option, naming it when no tile carries it; for
 * an ask without one, why the stage could not choose, when the card says.
 */
function RecommendationWhy({
  wait,
  unrecommended,
}: {
  wait: AttentionWait;
  unrecommended: string | undefined;
}): ReactElement | null {
  const { recommendation } = wait;
  if (recommendation === undefined)
    return unrecommended === undefined ? null : (
      <p
        data-unrecommended=""
        className="text-console-13 text-text-secondary [overflow-wrap:anywhere]"
      >
        {unrecommended}
      </p>
    );
  const matched = wait.options.some(option => option.id === recommendation.option);
  return (
    <p className="text-console-13 text-text-secondary [overflow-wrap:anywhere]">
      {matched ? '' : `Recommended: ${recommendedLabel(wait) ?? ''}. `}
      {recommendationWhy(recommendation)}
    </p>
  );
}

/**
 * A run's paused attention wait, answered at the occurrence the run reports, so the server
 * refuses the answer if the run has moved on.
 */
export function AttentionAnswerPanel({
  run,
  attention,
}: {
  run: Run;
  attention: Attention;
}): ReactElement | null {
  if (isLegacyAttention(attention)) return null;
  const submit: SubmitAnswer = async (choose, text) => {
    try {
      if (!run.id.startsWith('demo-')) {
        await skill.answerRun(run.id, attention.occurrence, choose, text);
      }
    } finally {
      // A refusal usually means the run moved on; refresh so the stale wait goes too.
      invalidate('runs');
      invalidate(K.run(run.id));
    }
  };
  return (
    <div className="@container mt-2">
      <AttentionAnswerForm wait={attention} submit={submit} />
    </div>
  );
}
