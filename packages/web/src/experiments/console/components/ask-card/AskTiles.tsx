import { ArrowRight, Check } from 'lucide-react';
import type { ReactElement } from 'react';
import { markProps, RECOMMENDED_BG, RecommendedBadge } from './tile-marks';

/** One choice an ask offers, as a tile draws it. */
export interface AskTile {
  id: string;
  /** Its words (rule 8); never a raw id. */
  label: string;
  /** What choosing it starts, in the factory view's words, when the view says. */
  starts?: string;
  /** What choosing it does, when the ask says. */
  does?: string;
  /** What choosing it costs, when the ask says. */
  cost?: string;
  recommended: boolean;
  /** The reserved `other` option: "Something else", answered in words. */
  other: boolean;
}

// Its explicit min-width (not `auto`) and max-w-full keep a long unbroken word from widening it.
// console-token-exception min-w-[176px] -- Visual standard rule 9: an option tile is at least 176 px wide.
const TILE = 'min-w-[176px] max-w-full';
const BASE = `${TILE} group flex flex-1 flex-col items-start gap-1 rounded-console-12 border p-3 text-left transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50`;
const PLAIN = 'border-border bg-surface hover:border-border-bright hover:bg-surface-elevated';
const OTHER = 'border-dashed border-border-bright bg-surface hover:bg-surface-elevated';

/**
 * Selected depends on the pick alone; the recommendation only adds its green (rule 9). The
 * border colour of either mark comes from `markProps`.
 */
function tileClass(tile: AskTile, picked: boolean): string {
  if (picked) return `${BASE} ${tile.recommended ? RECOMMENDED_BG : 'bg-surface-elevated'}`;
  if (tile.recommended) return `${BASE} ${RECOMMENDED_BG}`;
  return `${BASE} ${tile.other ? OTHER : PLAIN}`;
}

/**
 * An ask's choices as a wrapping row of tiles (Visual standard rule 9), stacked full width
 * where the card is under 520 px wide: the card is the container, so a 480 px popover stacks
 * too. A tile is a toggle: choosing one does not send; the confirm row under the tiles does.
 */
export function AskTiles({
  tiles,
  picks,
  onPick,
  disabled = false,
}: {
  tiles: readonly AskTile[];
  picks: readonly string[];
  onPick: (id: string) => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label="Options"
      className="flex flex-col gap-2 @min-[520px]:flex-row @min-[520px]:flex-wrap"
    >
      {tiles.map(tile => {
        const picked = picks.includes(tile.id);
        return (
          <button
            key={tile.id}
            type="button"
            aria-pressed={picked}
            data-recommended={tile.recommended || undefined}
            disabled={disabled}
            title={[
              tile.starts,
              tile.does,
              tile.cost === undefined ? undefined : `Cost: ${tile.cost}`,
            ]
              .filter(line => line !== undefined)
              .join('\n')}
            onClick={() => {
              onPick(tile.id);
            }}
            className={tileClass(tile, picked)}
            {...markProps(picked, tile.recommended)}
          >
            <TileBody tile={tile} picked={picked} />
          </button>
        );
      })}
    </div>
  );
}

const WORDS = 'w-full text-console-13 text-text-secondary [overflow-wrap:anywhere]';

/**
 * A tile's words: its label (with the check when chosen), the green badge when recommended,
 * what choosing it starts when the factory view words it (whole, never clamped), then what it
 * does and costs, each wrapping a long unbroken path inside the tile. At rest
 * those clamp to 2 lines (rule 9); a chosen tile shows them whole, and so does a tile with
 * keyboard focus, so the operator reads what an option costs before Confirm, on touch or
 * keyboard as well as by hover.
 */
function TileBody({ tile, picked }: { tile: AskTile; picked: boolean }): ReactElement {
  const does = tile.other ? 'Write your own answer' : tile.does;
  const clamp = picked ? '' : 'line-clamp-2 group-focus-visible:line-clamp-none';
  return (
    <>
      <span className="flex w-full items-start justify-between gap-2">
        <span className="min-w-0 text-console-14 font-semibold text-text-primary [overflow-wrap:anywhere]">
          {tile.label}
        </span>
        {picked ? <Check aria-hidden className="size-4 shrink-0 text-accent" /> : null}
      </span>
      {tile.recommended ? <RecommendedBadge /> : null}
      {tile.starts === undefined ? null : (
        <span
          data-starts=""
          className="flex w-full items-start gap-1.5 text-console-13 font-medium text-text-primary [overflow-wrap:anywhere]"
        >
          <ArrowRight aria-hidden className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" />
          <span className="min-w-0">{tile.starts}</span>
        </span>
      )}
      {does === undefined ? null : <span className={`${clamp} ${WORDS}`}>{does}</span>}
      {tile.cost === undefined ? null : (
        <span className={`${clamp} ${WORDS}`}>Cost: {tile.cost}</span>
      )}
    </>
  );
}
