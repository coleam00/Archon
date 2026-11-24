import { useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react';
import { gateChoices, respondToGate } from '../../lib/gate-response';
import { errorDetail } from '../../lib/http';
import type { Run } from '../../primitives/run';
import { AskConfirm } from './AskConfirm';
import { AskTiles } from './AskTiles';

const PLACEHOLDER = {
  optional: 'Optional comment to send with your answer',
  required: 'Why is the agent going the wrong way? This is sent back as feedback.',
} as const;

/**
 * A paused gate answered as the ask card draws it: one tile per decision the gate declared
 * (`gateChoices`, the owner `ApprovalPanel` reads too), then the confirm row. Approve takes an
 * optional comment; every other decision requires its reason before Confirm.
 */
export function GateAnswer({
  run,
  onAnswered,
}: {
  run: Run;
  onAnswered?: (label: string) => void;
}): ReactElement {
  const [pick, setPick] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = gateChoices(run, text);
  const chosen = choices.find(choice => choice.id === pick);

  const reset = (): void => {
    setPick(null);
    setText('');
    setError(null);
  };
  const confirm = async (): Promise<void> => {
    if (chosen === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await respondToGate(run, chosen.id, text);
      reset();
      onAnswered?.(chosen.label);
    } catch (e: unknown) {
      setError(errorDetail(e));
    } finally {
      setBusy(false);
    }
  };
  const stopPropagation = (e: MouseEvent | KeyboardEvent): void => {
    e.stopPropagation();
  };
  return (
    <div className="flex flex-col gap-3" onClick={stopPropagation} onKeyDown={stopPropagation}>
      <AskTiles
        tiles={choices.map(choice => ({
          id: choice.id,
          label: choice.label,
          recommended: false,
          other: false,
        }))}
        picks={pick === null ? [] : [pick]}
        disabled={busy}
        onPick={id => {
          setPick(id === pick ? null : id);
          setError(null);
        }}
      />
      {chosen === undefined ? null : (
        <AskConfirm
          draft={{
            labels: [chosen.label],
            text: chosen.text,
            placeholder: PLACEHOLDER[chosen.text],
          }}
          value={text}
          onChange={setText}
          accepted={chosen.text === 'optional' || text.trim().length > 0}
          busy={busy}
          error={error}
          onConfirm={() => void confirm()}
          onCancel={reset}
        />
      )}
    </div>
  );
}
