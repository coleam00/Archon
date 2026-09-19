import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  composeAnswer,
  isComplete,
  setCustomAnswer,
  toggleChoice,
  type Answer,
  type AskQuestion,
  type AskSpec,
} from '../primitives/ask';

interface AskCardProps {
  spec: AskSpec;
  /**
   * Send the composed answer as a chat message. Absent when the reply is being
   * read rather than answered (history, or a stream with no composer), in which
   * case the card renders as a read-only record of what was asked.
   */
  onAnswer?: (text: string) => void;
}

/**
 * The filled button, in both states.
 *
 * The disabled look is an inline style rather than a `disabled:bg-*` utility:
 * the console scope resolves its palette through CSS variables, and the variant
 * lost to the base background — which rendered a disabled Submit as magenta
 * text on a magenta fill, i.e. unreadable exactly when it is telling you that
 * you still have questions to answer.
 */
const PRIMARY_BUTTON =
  'rounded-md px-3.5 py-1.5 font-mono text-[11.5px] font-semibold tracking-[0.06em] transition-[filter] enabled:hover:brightness-110 disabled:cursor-not-allowed';

function primaryStyle(disabled: boolean): CSSProperties {
  return disabled
    ? { background: 'var(--surface-bright)', color: 'var(--text-tertiary)' }
    : { background: 'var(--brand-magenta)', color: 'var(--background)' };
}

/** Keycap letters. Ten options is far past the point the list stops being readable. */
const KEYS = 'ABCDEFGHIJ';

/**
 * Option text renders as inline markdown, with everything interactive or
 * block-level unwrapped to its text.
 *
 * An allowlist rather than a few overrides. Option labels sit inside a
 * `<button>`, and react-markdown would otherwise use its defaults for every
 * node it was not told about: a link becomes an `<a>` nested in the button,
 * whose click both navigates and bubbles up to select the option, and a list or
 * heading becomes block content inside a button, which is not valid HTML.
 *
 * Emphasis and code survive because they are inline and inert. Everything else
 * keeps its text and loses its element.
 */
const UNWRAP = ({ children }: { children?: React.ReactNode }): ReactElement => <>{children}</>;

const INLINE_MD: Components = {
  code: ({ children }) => (
    <code className="rounded bg-surface-inset px-1 py-[1px] font-mono text-[0.86em] text-text-primary">
      {children}
    </code>
  ),
  em: ({ children }) => <em>{children}</em>,
  strong: ({ children }) => <strong>{children}</strong>,
  del: ({ children }) => <del>{children}</del>,
  // Interactive or block-level: keep the text, drop the element.
  a: UNWRAP,
  p: UNWRAP,
  h1: UNWRAP,
  h2: UNWRAP,
  h3: UNWRAP,
  h4: UNWRAP,
  h5: UNWRAP,
  h6: UNWRAP,
  ul: UNWRAP,
  ol: UNWRAP,
  li: UNWRAP,
  blockquote: UNWRAP,
  pre: UNWRAP,
  table: UNWRAP,
  thead: UNWRAP,
  tbody: UNWRAP,
  tr: UNWRAP,
  th: UNWRAP,
  td: UNWRAP,
  hr: () => <></>,
  img: () => <></>,
  input: () => <></>,
  br: () => <> </>,
};

function Inline({ text }: { text: string }): ReactElement {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={INLINE_MD}>
      {text}
    </ReactMarkdown>
  );
}

/**
 * The agent's multiple-choice question, as something you click.
 *
 * A whole set is answered before anything is sent. That is what makes paging
 * back real: until submission the answers exist only here, so changing one
 * costs nothing and needs no round trip. Sending once also means a set of seven
 * questions is one wait instead of seven.
 *
 * Sending locks the card. Once the answers are a message in the conversation
 * the card is a record of what was decided, and a control that still looks live
 * but cannot change anything reads worse than one that is plainly finished — a
 * correction is a new message, not a rewrite of an old one.
 *
 * A question takes one answer unless it sets `multi`, in which case clicking an
 * option adds it and clicking it again takes it away.
 *
 * Submitting composes the message a person would have typed and sends it
 * through the ordinary composer path, so the agent needs no new channel — see
 * `primitives/ask.ts`.
 */
export function AskCard({ spec, onAnswer }: AskCardProps): ReactElement {
  const { questions } = spec;
  const total = questions.length;

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(() => null));
  const [ownOpen, setOwnOpen] = useState(false);
  const [ownDraft, setOwnDraft] = useState('');
  const [sent, setSent] = useState(false);
  const ownRef = useRef<HTMLTextAreaElement | null>(null);

  const answered = answers.filter(a => a?.some(v => v.trim().length > 0) === true).length;
  const complete = isComplete(questions, answers);
  const readOnly = onAnswer === undefined || sent;

  const closeOwn = useCallback((): void => {
    setOwnOpen(false);
    setOwnDraft('');
  }, []);

  const goTo = useCallback(
    (next: number): void => {
      setIndex(Math.max(0, Math.min(total - 1, next)));
      closeOwn();
    },
    [total, closeOwn]
  );

  const choose = useCallback(
    (value: string, custom = false): void => {
      const question = questions[index];
      const multi = question?.multi === true;
      setAnswers(prev => {
        const next = [...prev];
        // Free text is a correction, not an extra choice — see setCustomAnswer.
        next[index] = custom
          ? setCustomAnswer(prev[index] ?? null, value, question?.options ?? [], multi)
          : toggleChoice(prev[index] ?? null, value, multi);
        return next;
      });
      closeOwn();
      // Advance so a set can be answered without reaching for the mouse between
      // questions; the last answer stays put so the review state is visible.
      // A multi-answer question is not finished after one click, so it stays.
      if (!multi && index < total - 1) setIndex(index + 1);
    },
    [index, total, questions, closeOwn]
  );

  const submit = useCallback((): void => {
    if (onAnswer === undefined || !complete) return;
    setSent(true);
    onAnswer(composeAnswer(questions, answers));
  }, [onAnswer, complete, questions, answers]);

  // Keyboard: letters pick, arrows page, ⌘/Ctrl+Enter sends. Bound to the card
  // rather than the document so typing in the composer is never intercepted.
  // Letters and arrows are pager-mode only — with every question on screen at
  // once there is no "current" question for a letter to belong to.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (readOnly) return;
    if (e.target instanceof HTMLTextAreaElement) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (ownDraft.trim().length > 0) choose(ownDraft.trim(), true);
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goTo(index - 1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      goTo(index + 1);
      return;
    }
    const question = questions[index];
    if (question === undefined) return;
    const slot = KEYS.indexOf(e.key.toUpperCase());
    if (slot === -1) return;
    const option = question.options[slot];
    if (option !== undefined) {
      e.preventDefault();
      choose(option.label);
      return;
    }
    if (question.allowOwn !== false && slot === question.options.length) {
      e.preventDefault();
      setOwnOpen(true);
      setOwnDraft('');
    }
  };

  useEffect(() => {
    if (ownOpen) ownRef.current?.focus();
  }, [ownOpen]);

  const question = questions[index];
  if (question === undefined) return <></>;

  const chosen = answers[index] ?? [];
  const sendLabel = sent ? 'Sent' : `Submit all ${String(total)}`;

  return (
    <div
      // Focusable so the keyboard shortcuts have somewhere to land without
      // stealing keys from the rest of the page.
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="my-2 overflow-hidden rounded-[10px] border bg-surface outline-none focus-visible:border-accent-bright"
      style={{ borderColor: 'var(--border-bright)' }}
    >
      <header
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-surface-inset px-3.5 py-2.5"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="font-mono text-[10.5px] font-semibold tracking-[0.18em] uppercase text-text-secondary">
          {sent ? (
            <>
              Answered · <span className="text-text-primary">{total}</span> question
              {total === 1 ? '' : 's'}
            </>
          ) : (
            <>
              Question <span className="text-text-primary">{index + 1}</span> of{' '}
              <span className="text-text-primary">{total}</span>
            </>
          )}
        </span>
        {question.chip !== undefined ? (
          <span className="rounded bg-surface-bright px-[7px] py-[2px] font-mono text-[11px] text-text-secondary">
            {question.chip}
          </span>
        ) : null}

        {total > 1 ? (
          <div className="ml-auto flex items-center gap-2.5">
            <div className="flex items-center gap-[5px]">
              {questions.map((q, i) => {
                const done = (answers[i] ?? []).some(v => v.trim().length > 0);
                return (
                  <button
                    key={q.title + String(i)}
                    type="button"
                    aria-label={`Question ${String(i + 1)} of ${String(total)}`}
                    aria-current={i === index}
                    onClick={() => {
                      goTo(i);
                    }}
                    className={`h-[7px] w-[7px] rounded-full border transition-colors ${
                      i === index
                        ? 'border-accent-bright bg-accent-bright'
                        : done
                          ? 'border-success bg-success'
                          : 'border-border-bright bg-transparent hover:border-text-tertiary'
                    }`}
                  />
                );
              })}
            </div>
            <div className="flex gap-1.5">
              <PagerButton
                label="← Prev"
                disabled={index === 0}
                onClick={() => {
                  goTo(index - 1);
                }}
              />
              <PagerButton
                label="Next →"
                disabled={index === total - 1}
                onClick={() => {
                  goTo(index + 1);
                }}
              />
            </div>
          </div>
        ) : null}
      </header>

      <QuestionBlock
        question={question}
        chosen={chosen}
        readOnly={readOnly}
        ownOpen={ownOpen}
        ownDraft={ownDraft}
        ownRef={ownRef}
        onOwnDraft={setOwnDraft}
        onOpenOwn={() => {
          const custom = chosen.find(c => !question.options.some(o => o.label === c));
          setOwnOpen(true);
          setOwnDraft(custom ?? '');
        }}
        onCancelOwn={closeOwn}
        onChoose={choose}
      />

      <footer
        className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t bg-surface-inset px-3.5 py-2.5"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="flex items-center gap-2 font-mono text-[11px] text-text-secondary">
          {answered} of {total} answered
          <span className="h-1 w-24 overflow-hidden rounded-sm bg-surface-bright">
            <span
              className="block h-full rounded-sm bg-success transition-[width]"
              style={{ width: `${String(Math.round((answered / total) * 100))}%` }}
            />
          </span>
        </span>
        <div className="ml-auto flex items-center gap-3">
          {readOnly ? null : (
            <span className="font-mono text-[11px] text-text-tertiary">
              {`A–${KEYS[question.options.length] ?? 'A'}`}
              {total > 1 ? ' · ←/→ to page' : ''}
            </span>
          )}
          {onAnswer !== undefined ? (
            <button
              type="button"
              disabled={!complete || sent}
              onClick={submit}
              className={PRIMARY_BUTTON}
              style={primaryStyle(!complete || sent)}
            >
              {sendLabel}
            </button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

/** One question: its evidence, its title, its options, and the free-text row. */
function QuestionBlock({
  question,
  chosen,
  readOnly,
  ownOpen,
  ownDraft,
  ownRef,
  onOwnDraft,
  onOpenOwn,
  onCancelOwn,
  onChoose,
}: {
  question: AskQuestion;
  /** The option labels chosen so far. More than one only when the question is `multi`. */
  chosen: string[];
  readOnly: boolean;
  ownOpen: boolean;
  ownDraft: string;
  ownRef: React.RefObject<HTMLTextAreaElement | null>;
  onOwnDraft: (v: string) => void;
  onOpenOwn: () => void;
  onCancelOwn: () => void;
  onChoose: (value: string, custom?: boolean) => void;
}): ReactElement {
  const ownSlot = KEYS[question.options.length] ?? '?';
  const custom = chosen.find(c => !question.options.some(o => o.label === c));

  return (
    <div>
      <div className="px-4 pt-3.5">
        {question.multi === true ? (
          <div className="mb-2 font-mono text-[10.5px] font-semibold tracking-[0.18em] uppercase text-text-tertiary">
            Choose any that apply
          </div>
        ) : null}
        {question.evidence !== undefined ? (
          <div
            className="mb-3 border-l-2 pl-3 text-[13px] leading-[1.6] text-text-secondary"
            style={{ borderColor: 'var(--border-bright)' }}
          >
            <Inline text={question.evidence} />
          </div>
        ) : null}
        <div className="mb-3 text-[15px] leading-[1.4] font-semibold text-text-primary">
          <Inline text={question.title} />
        </div>
      </div>

      <div className="flex flex-col gap-2 px-4 pb-3.5">
        {question.options.map((option, i) => (
          <OptionRow
            key={option.label + String(i)}
            slot={KEYS[i] ?? '?'}
            label={option.label}
            detail={option.detail}
            recommended={option.recommended === true}
            why={option.why}
            chosen={chosen.includes(option.label)}
            readOnly={readOnly}
            onClick={() => {
              onChoose(option.label);
            }}
          />
        ))}

        {question.allowOwn === false || readOnly ? null : ownOpen ? (
          <div
            className="grid grid-cols-[30px_1fr] items-start gap-x-3 gap-y-[3px] rounded-lg border px-3.5 py-3"
            style={{ borderColor: 'var(--brand-magenta)' }}
          >
            <Keycap slot={ownSlot} tone="chosen" />
            <span className="text-[14.5px] font-semibold text-text-primary">Your own answer</span>
            <div className="col-start-2 mt-2 flex flex-col gap-2">
              <textarea
                ref={ownRef}
                value={ownDraft}
                onChange={e => {
                  onOwnDraft(e.target.value);
                }}
                placeholder="Type your answer…"
                className="min-h-[62px] w-full resize-y rounded-md border bg-surface-inset px-3 py-2 text-[13.5px] leading-[1.5] text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-bright"
                style={{ borderColor: 'var(--border-bright)' }}
              />
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  disabled={ownDraft.trim().length === 0}
                  onClick={() => {
                    onChoose(ownDraft.trim(), true);
                  }}
                  className={PRIMARY_BUTTON}
                  style={primaryStyle(ownDraft.trim().length === 0)}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={onCancelOwn}
                  className="rounded-md border px-3 py-1.5 font-mono text-[11.5px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                  style={{ borderColor: 'var(--border-bright)' }}
                >
                  Cancel
                </button>
                <span className="font-mono text-[11px] text-text-tertiary">⌘↵ to save</span>
              </div>
            </div>
          </div>
        ) : (
          <OptionRow
            slot={ownSlot}
            label={custom ?? 'Type your own…'}
            chosen={custom !== undefined}
            dashed
            readOnly={false}
            onClick={onOpenOwn}
          />
        )}
      </div>
    </div>
  );
}

function PagerButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-[5px] border px-2 py-[3px] font-mono text-[11px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
      style={{ borderColor: 'var(--border-bright)' }}
    >
      {label}
    </button>
  );
}

function Keycap({
  slot,
  tone,
}: {
  slot: string;
  tone: 'plain' | 'recommended' | 'chosen';
}): ReactElement {
  const toneClass =
    tone === 'recommended'
      ? 'text-success'
      : tone === 'chosen'
        ? 'text-accent-bright'
        : 'text-text-secondary';
  return (
    <span
      aria-hidden
      className={`flex h-[26px] w-[26px] items-center justify-center rounded-[5px] border border-b-2 bg-surface-inset font-mono text-[12px] font-semibold ${toneClass}`}
      style={{
        borderColor:
          tone === 'recommended'
            ? 'color-mix(in oklch, var(--brand-teal), transparent 45%)'
            : tone === 'chosen'
              ? 'var(--brand-magenta)'
              : 'var(--border-bright)',
      }}
    >
      {slot}
    </span>
  );
}

function OptionRow({
  slot,
  label,
  detail,
  recommended = false,
  why,
  chosen,
  dashed = false,
  readOnly,
  onClick,
}: {
  slot: string;
  label: string;
  detail?: string;
  recommended?: boolean;
  why?: string;
  chosen: boolean;
  dashed?: boolean;
  readOnly: boolean;
  onClick: () => void;
}): ReactElement {
  // Chosen wins over recommended: once the user has picked, the card should
  // show what they decided, not keep arguing for the suggestion.
  const borderColor = chosen
    ? 'var(--brand-magenta)'
    : recommended
      ? 'color-mix(in oklch, var(--brand-teal), transparent 55%)'
      : 'var(--border)';
  const background = chosen
    ? 'color-mix(in oklch, var(--brand-magenta), var(--surface-elevated) 90%)'
    : recommended
      ? 'color-mix(in oklch, var(--brand-teal), var(--surface-elevated) 94%)'
      : 'var(--surface-elevated)';

  return (
    <button
      type="button"
      disabled={readOnly}
      onClick={onClick}
      aria-pressed={chosen}
      className={`grid w-full grid-cols-[30px_1fr] items-start gap-x-3 gap-y-[3px] rounded-lg border px-3.5 py-3 text-left transition-colors enabled:hover:brightness-110 disabled:cursor-default ${
        dashed && !chosen ? 'border-dashed' : ''
      }`}
      style={{ borderColor, background }}
    >
      <Keycap slot={slot} tone={chosen ? 'chosen' : recommended ? 'recommended' : 'plain'} />
      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[14.5px] font-semibold text-text-primary">
        <Inline text={label} />
        {recommended && !chosen ? (
          <span
            className="rounded-full border px-2 py-[2px] font-mono text-[9.5px] font-bold tracking-[0.14em] uppercase text-success"
            style={{
              borderColor: 'color-mix(in oklch, var(--brand-teal), transparent 65%)',
              background: 'color-mix(in oklch, var(--brand-teal), transparent 86%)',
            }}
          >
            ✦ Recommended
          </span>
        ) : null}
        {chosen ? (
          <span className="ml-auto font-mono text-[11px] text-accent-bright">✓ Your answer</span>
        ) : null}
      </span>
      {detail !== undefined ? (
        <span className="col-start-2 text-[13px] leading-[1.55] text-text-secondary">
          <Inline text={detail} />
        </span>
      ) : null}
      {recommended && why !== undefined && !chosen ? (
        <span
          className="col-start-2 mt-1 flex gap-[7px] text-[12.5px] leading-[1.5]"
          style={{ color: 'color-mix(in oklch, var(--brand-teal), var(--text-primary) 35%)' }}
        >
          <span aria-hidden className="opacity-80">
            ↳
          </span>
          <span>
            <Inline text={why} />
          </span>
        </span>
      ) : null}
    </button>
  );
}
