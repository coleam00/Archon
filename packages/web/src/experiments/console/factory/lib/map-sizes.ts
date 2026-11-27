/**
 * The factory map's sizes, in world units (px at zoom 1, the map's least fitted zoom: its
 * smallest text is the type floor's 12 px, `map-camera.ts`). Their own module because the
 * layout (`map-layout.ts`), the send-backs (`map-send-backs.ts`) and the pills (`map-pill.ts`)
 * all size from them, and the layout imports the other two.
 *
 * A card is in the Visual standard's card language (rule 2), its height fixed by construction
 * so every card shares one and every send-back's legs leave one straight bottom edge (rows top
 * to bottom, 8 px apart, inside 12 px padding and the 3 px accent bar's 4 px):
 *
 * - a card of one stage: the icon and kind row (16), the stage label on up to two lines (40),
 *   its short line on up to two (36) and the chips on one row (20): 16 + 16 + 8 + 40 + 8 + 36
 *   + 8 + 20 + 12 = 164, so 168;
 * - a card of several stages: the kind row, the group label on one line (20), then a row per
 *   stage of two 20 px lines, the label with its "here" chip and under it the short line or
 *   the needs-you chip, 8 px apart: 16 + 16 + 8 + 20 + 8 + 12 = 80, and 48 per stage less the
 *   last gap, so 72 + 48 per stage: 168 for two.
 *
 * The width holds a chip row of "2 here" and "1 needs you" (about 150 px) inside the padding,
 * so no chip row wraps. It stays 184 whatever the height: only the rows of a card of three
 * stages need the height, and nothing in a card needs more width.
 *
 * Fit width: the shipped map is five cards of 184 by 216 (Intake holds three stages: 72 + 3 x
 * 48) and four gaps sized to their pills, 1313 px, plus twice `FIT_PAD`: 1345 px. The
 * Overview's frame at 1440x900 is narrower, so there the map pans a little at zoom 1, opening
 * at the row's start (Intake whole, Merged partly off the right); at 1280x720 and on a phone it
 * pans more.
 */
export const CARD_W = 184;
/** A card of one stage, and of two. */
export const CARD_H = 168;
/** What a card of several stages takes besides its stage rows, and what each row takes. */
const GROUP_BASE_H = 72;
const STAGE_ROW_H = 48;

/** The size every card takes when the fullest holds `most` stages. */
export function cardSize(most: number): { w: number; h: number } {
  const h = Math.max(CARD_H, GROUP_BASE_H + STAGE_ROW_H * most);
  return { w: CARD_W, h };
}

/** The least room between two cards (rule 3), and the room kept each side of a pill there. */
export const GAP_MIN = 48;
export const PILL_CLEAR = 8;
/** How far a forward pill's bottom sits above its line. */
export const PILL_GAP = 6;
/** From one line of a stacked pill to the next. */
export const PILL_LINE = 16;
/** From a card's bottom edge to a card's shallowest send-back track. */
export const LANE = 24;
/** From one send-back track of a card to the next one down. */
export const TRACK = 10;
