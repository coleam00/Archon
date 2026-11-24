/**
 * The document pages' pieces (DESIGN.md, owner change 5 of 2026-11-21). Every page of the
 * factory section that is not a canvas (a project's Settings page, a step page, an item page,
 * Needs you, a stage's "Items here now") is built from these, so the pages read alike and
 * `document.test-helpers.ts` can hold each one to the rule.
 *
 * - `Panel`: the filled surface content sits on, never an outline on the page colour. A nested
 *   row box is a `Panel inset`, a shade darker than what it sits on. A tone draws a 3 px bar.
 * - `SectionHeading`: a section's heading row: icon and eyebrow in the section's colour, the
 *   title in the primary text colour, an optional count and action at the right.
 * - `HeaderBand`: the full-width band a page opens with: title, one sentence, stat chips.
 * - `StatChip`: one key fact in the band: a figure and its label, optionally in a state colour
 *   or a kind colour.
 * - `DocumentColumns`: a main column and an aside, about 2:1, stacked on a phone.
 * - `DefinitionGrid`: label and value on one row, a label column of about 160 px.
 * - `IdTag`: an engine or setting id, small and mono, beside the plain-word heading.
 *
 * A tone is a CSS variable (`ToneColor`), so a raw hex or oklch value does not type-check.
 */
import type { CSSProperties, HTMLAttributes, ReactElement, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/** A colour token, as `var(--name)`: a group, kind or state colour from the theme. */
export type ToneColor = `var(--${string})`;

const toneStyle = (tone: ToneColor): CSSProperties => ({ '--doc-tone': tone }) as CSSProperties;

type PanelTag = 'div' | 'section' | 'li' | 'article';

/**
 * A filled panel: `--surface-elevated`, 1 px `--border`, `rounded-console-12` and the card
 * depth (theme.css, `[data-doc-panel]`). `inset` is a row box inside a panel, on
 * `--surface-inset` with no depth. `tone` with `bar` draws a 3 px bar in that colour on the
 * left or top edge, inside the radius.
 */
export function Panel({
  as: Tag = 'div',
  tone,
  bar,
  inset = false,
  className = '',
  children,
  ...rest
}: {
  as?: PanelTag;
  tone?: ToneColor;
  bar?: 'left' | 'top';
  inset?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'className' | 'style' | 'children'>): ReactElement {
  const fill = inset ? 'bg-surface-inset' : 'bg-surface-elevated';
  return (
    <Tag
      {...rest}
      data-doc-panel={inset ? 'inset' : 'panel'}
      style={tone === undefined ? undefined : toneStyle(tone)}
      className={`relative min-w-0 overflow-hidden rounded-console-12 border border-border [overflow-wrap:anywhere] ${fill} ${className}`}
    >
      {tone === undefined || bar === undefined ? null : (
        <span
          aria-hidden="true"
          data-doc-bar={bar}
          className={`absolute bg-[color:var(--doc-tone)] ${
            bar === 'left' ? 'inset-y-0 left-0 w-0.75' : 'inset-x-0 top-0 h-0.75'
          }`}
        />
      )}
      {children}
    </Tag>
  );
}

/** A section's heading row (owner change 5): icon and eyebrow in `tone`, title, count, action. */
export function SectionHeading({
  id,
  icon: Icon,
  eyebrow,
  title,
  tone,
  count,
  action,
}: {
  /** The heading's id, for the section's `aria-labelledby`. */
  id?: string;
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  tone: ToneColor;
  count?: number;
  action?: ReactNode;
}): ReactElement {
  return (
    <div data-doc-heading="" style={toneStyle(tone)} className="flex flex-wrap items-end gap-x-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2 text-console-12 font-medium uppercase tracking-console-label text-[color:var(--doc-tone)]">
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          {eyebrow}
        </span>
        <h2 id={id} className="text-console-17 font-semibold text-text-primary">
          {title}
        </h2>
      </div>
      {count === undefined && action === undefined ? null : (
        <div className="ml-auto flex items-center gap-3">
          {count === undefined ? null : (
            <span className="text-console-13 tabular-nums text-text-tertiary">{count}</span>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

/** The band a document page opens with: title, one plain sentence, and its key facts as chips. */
export function HeaderBand({
  title,
  sentence,
  chips,
  aside,
  className = '',
}: {
  title: ReactNode;
  sentence: ReactNode;
  /** `StatChip`s. */
  chips: ReactNode;
  /** At the right of the title on a wide screen: a switcher or a link. */
  aside?: ReactNode;
  /** Its place in the page's grid. */
  className?: string;
}): ReactElement {
  return (
    <Panel as="section" className={`flex flex-col gap-3 p-5 ${className}`} aria-label="Summary">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-console-22 font-semibold tracking-console-heading text-text-primary [overflow-wrap:anywhere]">
            {title}
          </h2>
          <p className="max-w-[80ch] text-console-14 text-text-secondary">{sentence}</p>
        </div>
        {aside}
      </div>
      <ul aria-label="Key facts" className="flex flex-wrap gap-2">
        {chips}
      </ul>
    </Panel>
  );
}

/** Rule 5's state colours, as text on the state's soft background; shadow is rule 10's. */
const STATE: Record<StatState, string> = {
  running: 'bg-[color:var(--running-soft)] text-[color:var(--running)]',
  'needs-you': 'bg-[color:var(--warning-soft)] text-warning',
  failed: 'bg-[color:var(--error-soft)] text-error',
  done: 'bg-[color:var(--success-soft)] text-success',
  shadow: 'border border-dashed border-[color:var(--node-opaque)] text-[color:var(--node-opaque)]',
};
type StatState = 'running' | 'needs-you' | 'failed' | 'done' | 'shadow';

/**
 * One key fact: a figure and its label, neutral, in a state colour, or with a dot and figure in a
 * kind or group colour (`tone`). A chip has a state or a tone, never both.
 */
export function StatChip({
  figure,
  label,
  ...look
}: {
  figure: ReactNode;
  label: string;
} & ({ state?: StatState; tone?: never } | { state?: never; tone: ToneColor })): ReactElement {
  const { state, tone } = look;
  const plain = state === undefined;
  return (
    <li
      data-stat-chip={tone !== undefined ? 'tone' : (state ?? 'neutral')}
      style={tone === undefined ? undefined : toneStyle(tone)}
      className={`inline-flex items-baseline gap-1.5 rounded-full px-3 py-1 text-console-13 ${
        plain ? 'bg-surface-inset text-text-secondary' : STATE[state]
      }`}
    >
      {tone === undefined ? null : (
        <span
          aria-hidden="true"
          className="size-2 shrink-0 self-center rounded-full bg-[color:var(--doc-tone)]"
        />
      )}
      <span
        className={`font-semibold tabular-nums ${
          tone !== undefined ? 'text-[color:var(--doc-tone)]' : plain ? 'text-text-primary' : ''
        }`}
      >
        {figure}
      </span>
      {label}
    </li>
  );
}

/**
 * A page's main column and its aside, about 2:1 from lg (owner change 5). The aside comes after
 * the main column in the document, so on a phone it falls below it.
 */
export function DocumentColumns({
  main,
  aside,
  asideLabel,
}: {
  main: ReactNode;
  aside: ReactNode;
  asideLabel: string;
}): ReactElement {
  return (
    <div
      data-doc-columns=""
      className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
    >
      <div className="flex min-w-0 flex-col gap-6">{main}</div>
      <aside aria-label={asideLabel} className="flex min-w-0 flex-col gap-6">
        {aside}
      </aside>
    </div>
  );
}

/** Label and value on one row (owner change 5); stacked on a phone. Long values wrap. */
export function DefinitionGrid({
  rows,
  className = '',
}: {
  rows: readonly { key: string; label: ReactNode; value: ReactNode }[];
  className?: string;
}): ReactElement {
  return (
    // console-token-exception sm:grid-cols-[160px_1fr] -- owner change 5 of 2026-11-21: a definition grid's label column is about 160 px.
    <dl className={`grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[160px_1fr] ${className}`}>
      {rows.map(row => (
        <div key={row.key} className="contents">
          <dt className="min-w-0 text-console-13 text-text-tertiary [overflow-wrap:anywhere]">
            {row.label}
          </dt>
          <dd className="min-w-0 text-console-14 text-text-primary [overflow-wrap:anywhere]">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** An engine or setting id beside its plain-word heading (owner change 5). */
export function IdTag({ id }: { id: string }): ReactElement {
  return (
    <span
      data-id-tag=""
      className="inline-block min-w-0 rounded bg-surface-inset px-1.5 font-mono text-console-12 text-text-tertiary break-all"
    >
      {id}
    </span>
  );
}
