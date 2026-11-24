import { useMemo, useState, type ReactElement } from 'react';
import { formatRelativeToBaseline, formatClock } from '../lib/format';
import { useStreamContext } from '../lib/stream-context';
import {
  shortenText,
  truncateParts,
  type PathToken,
  type ShortenedPart,
  type ShortenedText,
} from '../lib/run-paths';
import type { InlineToolCall } from '../primitives/message';

interface ToolCallItemProps {
  call: InlineToolCall;
  /** Carried from the parent message since metadata tool calls don't track their own timestamp. */
  timestamp: string;
  /** The run's known paths, shown as tokens. A chat has none. */
  paths?: readonly PathToken[];
  /** Show the call exactly as recorded: nothing shortened, nothing cut off. */
  exact?: boolean;
}

const NO_PATHS: readonly PathToken[] = [];

function inputFields(input: InlineToolCall['input']): Record<string, unknown> | null {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? input : null;
}

const ARG_VALUE_MAX = 48;

/** The first two arguments, as `key="value"`. */
function argsSummary(input: InlineToolCall['input'], paths: readonly PathToken[]): ShortenedText {
  const fields = inputFields(input);
  if (fields === null) {
    const text = (JSON.stringify(input) ?? '').slice(0, 80);
    return { parts: text.length > 0 ? [text] : [], droppedCheckoutPrefix: false };
  }
  const entries = Object.entries(fields);
  const parts: ShortenedPart[] = [];
  let droppedCheckoutPrefix = false;
  for (const [key, value] of entries.slice(0, 2)) {
    if (parts.length > 0) parts.push(' ');
    if (typeof value !== 'string') {
      parts.push(`${key}=${JSON.stringify(value)}`);
      continue;
    }
    const shortened = shortenText(value, paths);
    droppedCheckoutPrefix ||= shortened.droppedCheckoutPrefix;
    parts.push(`${key}="`, ...truncateParts(shortened.parts, ARG_VALUE_MAX), '"');
  }
  if (entries.length > 2) parts.push(` +${(entries.length - 2).toString()}`);
  return { parts, droppedCheckoutPrefix };
}

export interface ToolCallRow {
  /** The agent's own description of the call, when it gave one. It leads the row. */
  description: string | null;
  /** Without a description, the call's name: for a shell tool, usually its command. */
  name: ShortenedPart[];
  /** Under the lead: the command of a described call, otherwise the arguments. */
  second: ShortenedPart[];
  /** `input.command` exactly as recorded; null for a call that runs no command. */
  command: string | null;
  /** A shown line began with `cd <checkout> && `, which the row leaves out. */
  droppedCheckoutPrefix: boolean;
  /** The path tokens the row shows. */
  tokens: PathToken[];
}

/**
 * What a tool-call row shows for `call`. The run log calls this too, for its token key
 * and its per-node working-directory line, so those cannot disagree with the rows.
 */
export function toolCallRow(call: InlineToolCall, paths: readonly PathToken[]): ToolCallRow {
  const fields = inputFields(call.input);
  const description =
    typeof fields?.description === 'string' && fields.description.length > 0
      ? fields.description
      : null;
  const command = typeof fields?.command === 'string' ? fields.command : null;
  const name = shortenText(call.name, paths);
  const lines =
    description === null
      ? [name, argsSummary(call.input, paths)]
      : [command === null ? name : shortenText(command, paths)];
  return {
    description,
    name: name.parts,
    second: lines[lines.length - 1].parts,
    command,
    droppedCheckoutPrefix: lines.some(line => line.droppedCheckoutPrefix),
    tokens: lines.flatMap(line => line.parts).filter(part => typeof part !== 'string'),
  };
}

/** A known path's short name; the recorded path is its tooltip. */
export function PathTokenChip({ token }: { token: PathToken }): ReactElement {
  return (
    <span
      title={token.path}
      className="rounded-sm bg-[color:var(--accent-soft)] px-1 font-mono font-normal text-[color:var(--brand-magenta-2)]"
    >
      {token.token}
    </span>
  );
}

function Parts({ parts }: { parts: readonly ShortenedPart[] }): ReactElement {
  return (
    <>
      {parts.map((part, index) =>
        typeof part === 'string' ? part : <PathTokenChip key={index} token={part} />
      )}
    </>
  );
}

/** The row's two lines; with `exact` they wrap instead of being cut off. */
function RowLines({ shown, exact }: { shown: ToolCallRow; exact: boolean }): ReactElement {
  const overflow = exact ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'truncate';
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      {shown.description !== null ? (
        <span className={`min-w-0 text-console-13 font-semibold text-text-primary ${overflow}`}>
          {shown.description}
        </span>
      ) : (
        <span
          className={`min-w-0 font-mono text-console-13 font-bold text-text-primary ${overflow}`}
        >
          <Parts parts={shown.name} />
        </span>
      )}
      {shown.second.length > 0 ? (
        <span className={`min-w-0 font-mono text-console-12 text-text-tertiary ${overflow}`}>
          <Parts parts={shown.second} />
        </span>
      ) : null}
    </span>
  );
}

/** How the call ended and how long it took, as far as either was recorded. */
function CallOutcome({ call }: Pick<ToolCallItemProps, 'call'>): ReactElement {
  return (
    <>
      {call.status === 'failed' || call.status === 'cancelled' ? (
        <span className="shrink-0 font-mono text-console-12 text-error">
          {call.status}
          {call.exitCode !== undefined ? ` (exit ${call.exitCode.toString()})` : ''}
        </span>
      ) : null}
      {call.outcomeUnrecorded === true ? (
        <span className="shrink-0 font-mono text-console-12 text-text-tertiary">
          no result recorded
        </span>
      ) : null}
      {call.durationMs !== undefined ? (
        <span className="shrink-0 font-mono text-console-12 tabular-nums text-text-tertiary">
          {call.durationMs.toString()}ms
        </span>
      ) : null}
    </>
  );
}

/**
 * Tool-call row: offset gutter · purple TOOL tag · the agent's description with the
 * command under it (or the call's name with its arguments under it) · duration ·
 * chevron. When there is detail to show, the row is a button that toggles the recorded
 * command, input and result below it.
 */
export function ToolCallItem({
  call,
  timestamp,
  paths = NO_PATHS,
  exact = false,
}: ToolCallItemProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const { runStartedAt } = useStreamContext();
  const displayed = formatRelativeToBaseline(timestamp, runStartedAt);
  const wallClock = formatClock(timestamp);
  const shown = useMemo(() => toolCallRow(call, exact ? NO_PATHS : paths), [call, paths, exact]);
  const fields = inputFields(call.input);
  const hasInput = fields === null || Object.keys(fields).length > 0;
  const hasDetails = hasInput || (call.output !== undefined && call.output.length > 0);

  const row = (
    <>
      <time
        dateTime={timestamp}
        title={wallClock}
        className="w-14 shrink-0 font-mono text-console-12 tabular-nums text-text-tertiary"
      >
        {displayed}
      </time>
      <span
        className="shrink-0 rounded-sm border px-1.75 py-0.5 font-mono text-console-10 font-bold uppercase tracking-widest"
        // Inline because the console scope's wildcard border-color rule
        // repaints Tailwind border utilities (see theme.css).
        style={{
          color: 'var(--brand-violet)',
          background: 'color-mix(in oklch, var(--brand-violet), transparent 86%)',
          borderColor: 'color-mix(in oklch, var(--brand-violet), transparent 70%)',
        }}
      >
        Tool
      </span>
      <RowLines shown={shown} exact={exact} />
      <CallOutcome call={call} />
      {hasDetails ? (
        <span
          aria-hidden
          className="shrink-0 font-mono text-console-11 text-text-tertiary transition-transform"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          ▸
        </span>
      ) : null}
    </>
  );

  return (
    <div className="flex flex-col border-b border-border/60 py-2.75">
      {hasDetails ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(v => !v);
          }}
          className="flex w-full items-baseline gap-4 text-left transition-colors hover:bg-surface-hover/50"
        >
          {row}
        </button>
      ) : (
        <div className="flex items-baseline gap-4">{row}</div>
      )}
      {expanded && hasDetails ? (
        <ToolCallDetails call={call} command={shown.command} hasInput={hasInput} />
      ) : null}
    </div>
  );
}

const DETAIL_PRE =
  'rounded border border-border bg-surface-inset p-2 font-mono text-console-11 leading-relaxed text-text-secondary';

/** A call's recorded command, input and result. Nothing in it is shortened. */
export function ToolCallDetails({
  call,
  command,
  hasInput,
}: Pick<ToolCallItemProps, 'call'> & {
  command: string | null;
  hasInput: boolean;
}): ReactElement {
  return (
    <div className="ml-18 mt-2 space-y-1.5">
      {command !== null ? (
        <pre
          aria-label="Command"
          className={`max-h-80 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] ${DETAIL_PRE}`}
        >
          {command}
        </pre>
      ) : null}
      {hasInput ? (
        <pre className={`max-h-80 overflow-auto ${DETAIL_PRE}`}>
          {JSON.stringify(call.input, null, 2)}
        </pre>
      ) : null}
      {call.output !== undefined && call.output.length > 0 ? (
        <div>
          <div className="mb-0.5 text-console-9 font-semibold uppercase tracking-wider text-text-tertiary">
            Result
          </div>
          <pre className={`overflow-x-auto whitespace-pre-wrap break-words ${DETAIL_PRE}`}>
            {call.output.length > 2000
              ? `${call.output.slice(0, 2000)}\n\n… (${(call.output.length - 2000).toString()} more chars)`
              : call.output}
          </pre>
          {call.outputTruncated === true ? (
            <div className="mt-0.5 text-console-10 text-text-tertiary">
              Output cut short by the provider.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
