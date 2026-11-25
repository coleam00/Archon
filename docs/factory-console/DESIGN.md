# The Software Factory section of the Archon console

Owner: Cole Medin. Status: proof of concept, started 2026-11-16. This page binds every change in
this repository. Where an issue and this page disagree, this page wins unless the issue says it
changes this page.

## COMBINED direction, 2026-11-25 (owner; binds every change on the `combined` branch; wins over everything below, including the v2 direction)

The branch `combined` starts from Archon maintainer Rasmus's Console stack (coleam00/Archon #6203
to #6215, top commit 2e85cb01f): the pack `document` with frontmatter `groups`, the item `title`
column, the Board tab with server-side item `standing` (`item-standing.ts`), the Done column and
work-order strips, the install-wide Needs you page, the pack Setup and Settings pages, and the
project Overview tab. That is the base. On top of it goes the owner's curated layer from this
repository's `main` (tag `console-v1-full` is the full v1 reference; screenshots of every v1
page are in `C:/Users/colem/OpenSource/fc-runtime/baseline-v1/`; v1 is served at
http://127.0.0.1:3195/console). Rules:

- **Keep Rasmus's pages and engine reads working.** Board, Needs you, Setup, Settings and the
  Overview tab stay; build on them, do not replace them with a second copy. His
  `itemStanding` is the one placement on the server; extend and correct it, do not add a
  parallel one.
- **The curated view JSON ships with the pack and draws the core map (non-negotiable).** A
  hand-curated presentation file travels in the pack (for now `<pack>/.shared/<name>.json`, read
  through `packages/workflows/src/pack-declarations.ts`). It carries presentation only: group
  words, stage labels and blurbs, layout positions, lanes, captions, edge labels, drill-down
  cards and story wording (how each outcome reads; words for rounds, returns, parked, work
  orders). Structure (stages, steps, outcomes, arrows) comes from the pack graph. The file is
  validated against the graph: unknown stage, workflow, step or outcome names fail; graph stages
  it leaves unplaced warn.
- **ONE check where the map is drawn.** If the pack ships the curated JSON, draw the curated map
  (the project Overview's map and the sidebar How it works, with their drill-down views and the
  stage modal). If not, draw the map derived from the pack graph and its document groups. No
  merging of the two and no per-stage mixing. The derived map is also offered as a secondary
  "Full workflow" view.
- **No item page.** A board card opens the item's run log (Rasmus's behaviour). The CARD carries
  the item's iteration detail as v1's cards did: title, running step, check-round dots and
  "N of M check rounds", returned / "sent back Nx", PR link, the green "Recommended: <label>"
  line from the ask record and "N open asks".
- **The project's Needs you tab** (`routes/ProjectNeedsYouPage.tsx`, the first project tab; owner
  after the 11/25 review). `?item=<key>` shows only that item's asks; the value is the raw key or
  the issue number (`198` and `issue-198` name one item; a parent's number does not take in its
  split members), repeatable or comma-separated. Each value has a chip "Item #N ×" linking to the
  page without it, and a filter that matches nothing says so beside its chip. A filtered item
  with one ask opens that ask's section directly. Rows print the key and title as the board card
  does (`#171`, members `#199 · board card`, the forge issue's title when the `title` column is
  empty). The recommendation reads "Suggested: <label>" in `--text-secondary`, never green,
  because a green line read as if the ask were already answered. Answering stays in Archon's
  ask section. The board card's green "Recommended" line above is not changed by this.
- **Keep, all required:** the stage modal ("What this stage does" curated cards, "Items here
  now", "The real workflow" step list); rich board cards; work orders "N of N merged" with split
  parents resolved when their pieces merged and run-less work orders listed; the Merged column
  (last 7 days) and the number tiles including median time to merged; Pipeline/Table toggle; the
  Visual identity and Visual standard below on every factory page.
- **Correctness both sides need:** a run that recorded no pack still places (from its workflow
  name or the item's other runs) so every merged item reaches Done/Merged; a cancelled-on-purpose
  item reads as at rest, not failed; a refused or failed start reads as "needs a decision"
  (Rasmus's); titles come from the forge issue (fill the `title` column), never from prose.
- **The engine stays generic** (as in the v2 direction): rounds, returns, stories and their words
  are computed in the web from generic run records plus the curated JSON's words.
- **Nothing is lost.** Every change is checked in a browser at 1440x900 on a copy of the live
  database against v1 (:3195 and the baseline screenshots) and against Rasmus's base; a
  regression in what a person sees is a failed change.

## v2 direction, 2026-11-24 (owner; binds every later change; wins over everything below)

The owner accepted the review of draft Archon PR #6151 by Archon's core maintainer (Rasmus), all
of it. The section is slimmed down so it can go upstream as a small pull request: about 8-11K web
source lines and a small generic server part. Where any later section of this page says
otherwise, this section wins.

**What stays.** The curated factory view, as beautiful as it is now (the Visual identity and the
Visual standard below still bind everything a person sees):

- **How it works**, in the sidebar Factory entry.
- The project's **Factory** tab: the **Overview** with its map and the stage modal, and the
  **Board** (with its strips under the board, its work orders section and its Table view).
- The **item page**, as the item's ONE history: story, rounds and asks in one account.
- The **view JSON** (the factory view and overview files), hand-written and curated per pack,
  as **presentation only**: labels, blurbs, grouping, order, layout, captions, edge labels and
  story wording. It moves into the owner's own copy of the pack later; until then it lives in
  this repository.

**What goes.**

- **Step pages.** A step is plain text in its stage's list. Archon has no page that shows an
  installed pack's workflow (the builder opens a pack workflow read-only and draws nothing), so
  nothing links to one.
- **The Settings page** (sidebar and project tab) and the pack-settings read. Archon issue
  #5317 owns pack settings.
- **The pack index page.** `/console/factory` opens How it works.
- **Shadows**, everywhere: no shadow step, badge, line, count, colour or explanation is drawn,
  counted or described, and no code exists to do so.
- **Regex parsing of agent prose**: no reading of ask options, "The stage recommends", "No
  recommendation:", item titles or findings out of text. Ask options and the recommendation
  come from the ask record (its structured options and `recommendation.option`; #6139 lets a
  workflow declare them); titles from the item record or the forge;
  findings link to items by id.
- **Any change to Archon's own Console outside `factory/`**: the answer panel, the ask card, the
  project tabs (Runs, Chat, Metrics) and every generic page stay exactly as on Archon dev. There
  is no Needs you tab: Archon dev has none, and the factory's asks show on its board and item
  pages through Archon's own ask components. The
  factory adds a sidebar entry, a project tab and their routes, nothing else, and its view is
  read only for a project whose pack has one. `bun run lint` (`scripts/check-factory-imports.ts`)
  fails when any other file under `packages/web/src` imports from `factory/`: only
  `ConsoleApp.tsx` (the routes), `ProjectRail.tsx` (the entry) and `ProjectViewTabs.tsx` (the
  tab) may.

**Structure comes from the pack graph.** `GET /api/packs/{pack}/graph` gives stages, steps,
outcomes, asks and arrows. The view JSON names workflows, steps and outcomes only to give them
words, a group and a position; it never lists or adds structure. A check fails when the view
names something the graph lacks and warns when the graph has something the view leaves out.

**One of each.** One items-in-a-stage list (board column, map card, stage modal), one ask
(Archon's own ask card), one item history (the item page), one graph renderer (Archon's existing
one where it can draw it, else exactly one new one), and placement computed once, in the web,
with no parity test.

**The engine has no pack vocabulary.** `packages/workflows` and `packages/server` expose only
generic reads (items, runs and outcomes, asks with declared options, item links, the pack graph,
the view file) and know nothing of rounds, returns, shadows, parked items, discoveries, work
orders, item stories or stage groups. The web composes those from the generic reads and the view
JSON's words. The batched item-start read stays.

**Tests assert behaviour a person sees.** No assertion on a CSS class, a colour, a token or an
exact sentence of copy. Test lines stay at most half of source lines.

**Carried over** (owner-approved, keep them working): the strips under the board with one
toggle (#152); work orders as a board section, each row opening its order (#153); a step card
opening directly (#154) is gone with the step pages: steps are a plain list; plain number tiles, map counts that match
the board, and How it works naming no project (#151); the factory's own sub-navigation (Overview |
Board) revealing the active tab at phone width (#155; the project tab row itself is Archon's, as
on dev plus a Factory entry, with all four tabs reachable at 390 px); #111's story still tells; 390 px works everywhere. "Found by the factory" and "Set
aside" stay only while their data is generic (discoveries as items or links, parked as an
outcome the view names); otherwise they go.

**While main is being slimmed.** Main still holds much of what this section removes or rules
out (pages, engine read models, view-file fields, tests that pin visuals, Console changes outside
`factory/`, imports from `factory/`); the removals land issue by issue. No change adds to or
extends any of it. A change is not returned for leaving such code in place when its own issue
does not cover it, nor for removing it. Sections below that still describe it describe today's
code, not a requirement.

## Owner changes of 2026-11-23 (bind every later change; win over everything below, 2026-11-21 included)

From the owner's review on 2026-11-23 (#151).

1. **The sidebar Factory is How it works only.** It is the Archon software factory that ships
   with Archon: a general view of how the pack works, not one project's factory. A pack's page
   has no tabs and no Settings, and nothing on it names a project: where the overview file was
   read from says "a project's copy", not which project. There is no pack index page:
   `/console/factory` opens How it works (v2 direction).
2. *(Removed in the v2 direction: there is no Settings page, in the sidebar or a project's
   Factory tab. Archon issue #5317 owns pack settings.)*
3. **Overview number tiles are plain numbers.** They are not links: no hover or focus state, no
   "Open the board..." words. They still count with the board's shows, so a number and the
   board agree.
4. **The map counts what the board counts.** An item the board sets aside (The board, Set
   aside) is counted and listed in no map stage: not in a card's "N here", not in a stage's
   "Items here now". Board and map make that decision in one place.
5. **Work orders are a visible part of the board** (#153). They are a section of the board
   above the Pipeline's columns at the board's text size, not a toggle in the toolbar: a header
   with the count of orders and open orders, and the list of orders under it, open by default
   and foldable from the header. Each order's row opens its item page. Highlight members stays a
   separate button that lights the members and never navigates. Nothing shows when no order has
   a started member.

## Owner changes of 2026-11-21 (bind every later change; win over everything below, 2026-11-19 included)

From the owner's review of the whole section on 2026-11-21, before the 2026-12-02 bootcamp. The
canvases (How it works, the Overview map, the board) are loved: "those all look so good". Every
other page reads as auto-generated: text slapped on the page background in outline boxes, shoved
to the left, half the screen empty, everything white. "No one following my workshop would use
this right now because it's just confusing." These changes fix that. They are design changes,
not polish: reshape a page when restyling it would not make it read well.

1. **How it works moves about 1.5 times faster.** Every duration in the flow loop is two thirds of
   what it is today (a dot's travel, its rest, the loop's pause), so one loop takes two thirds of
   the time. Nothing else about the loop changes.
2. **The Overview map has room to breathe.** At least 48 px of canvas above the drawing's top edge
   and below its bottom edge, at the opening zoom and after Fit, at 1440x900 and on a wide screen.
   The canvas grows taller to make that room (the drawing is never squeezed to fit a fixed
   height); it still opens at Intake and pans sideways.
3. *(Superseded by owner change 3 of 2026-11-23: the number tiles are plain figures, not links.
   The board's `?show=` addresses still work, and the strip still counts through them.)*
4. *(Removed in the v2 direction: "The real workflow" no longer draws its own step graph. It
   lists the stage's steps from the pack graph, each as plain
   text; see The map, Click.)*
5. **Document pages get a design of their own.** Every page in the section that is not a canvas
   (an item page, a stage's "Items here now") follows these rules, which win over rules 2, 3 and 5 of the Visual standard where they
   differ:
   - **Content sits on filled panels, never outlines on the page colour.** A panel is
     `--surface-elevated` (or `--surface` on an elevated page) with a 1 px `--border`,
     `rounded-console-12` and `--card-depth`; the page background shows only between panels.
     A row inside a panel that needs its own box is `--surface-inset`, so a box always differs from
     what it sits on.
   - **Sections are colour-coded.** Each section of a page has a heading row: a 16 px icon and the
     section's eyebrow label in the section's colour (a group colour, a kind colour from How it
     works, or a state colour), with the heading in `--text-primary`. On document pages a group
     or kind colour may be the colour of that eyebrow label and icon, and of a 3 px bar on the
     panel's left or top edge (this amends rule 5 of the Visual standard for document pages only).
     Body text stays `--text-secondary`; values a person scans for (a path, a model, a count) are
     `--text-primary`.
   - **The page uses its width.** At 1440x900 no page is a single column with the right third
     empty. A page is a header band across the full width, then a grid: a main column and an aside
     (about 2:1), or a grid of panels two or three across. Text measure stays readable (a paragraph
     is at most about 80 characters wide); the grid, not long lines, fills the width. At 390 px
     everything stacks into one column.
   - **Every page opens with a header band.** Title, one plain sentence saying what this page is,
     and the page's key facts as a row of stat chips (counts, state, time, cost), so the page
     reads at a glance before any detail.
   - **No dead space inside a box.** A label and its value sit on one row in a definition grid
     (label column about 160 px), not stacked with blank lines between; a panel is as tall as its
     content. Long values wrap (owner change 2 of 2026-11-19).
   - **Plain words first, ids second.** A heading is what a person calls the thing ("Code
     review"); the id (`review`) is a small mono tag beside it, never the heading.
   The shared pieces (panel, section heading, header band, stat chip, definition grid) are built
   once, in one module of the factory section, and every document page uses them. That every
   top-level box is a panel or a section with a heading row, and no box is an outline alone on
   the page background, is checked in the browser, not by a test.
6. *(Removed in the v2 direction: the Settings page.)*
7. *(Removed in the v2 direction: step pages. A step is plain text in its stage's list.)*
8. **The item page tells the story of the item.** Today it is a list of runs and a wall of red and
   green chips nobody can read. It becomes a story a person follows top to bottom:
   - **A journey strip** across the top: the item's path through the groups (Intake, Plan & build,
     Checks & review, Ready to merge, Merged), each step showing how long the item spent there,
     the current one lit, a send-back drawn as a loop back, an ask as a marked pause.
   - **A header band**: title, state, the PR, total time from order to now or to merge, cost,
     check rounds used, asks answered.
   - **The story**: one panel per stage in order, each opening with one plain sentence saying
     what happened ("Triage judged it worth building", "Build wrote the change and opened PR
     #112", "The checks sent it back once: the offered block was unclamped"), then its details.
   - **Check rounds as a grid, not chips**: rows are the checks (Code review, Tests, Product
     check, Verdict, CI and reviews), columns are
     rounds; each cell is an icon and a word ("Sent back", "Approved", "Fixed") in its state
     colour, with a legend saying what sent back and approved mean. The reason a round was sent
     back is one readable sentence under the grid, the full text behind "More". The rule to
     remember: a person must be able to say what happened in each round without hovering.
   - Asks and their answers appear in the story where they happened (the question, the option
     chosen, who chose it and what that started), not only in a separate list.
9. *(Removed in the v2 direction: the Needs you tab is Archon's own, as on Archon dev; the
   factory section does not redesign it.)*
10. **The section shows that the factory merges.** On the three-stage delivery the pack lands a
   change itself when the land gate or an operator says so. Wherever a person reads how merging
   works (the map's Ready to merge card and its drill-down, How it works, the item page), it says
   the gate asks and the factory merges on "land", not that a person merges by hand.

## Owner changes of 2026-11-19 (bind every later change; win over everything below, 2026-11-18 included)

From the owner's review of the finished work order #64. The section is close; these make it presentable.

1. **Less purple and pink, more green.** The brand magenta is an accent, not the page's colour. In the factory section, purple and pink are for one thing each (the running state, the active tab), not for card borders, headings or chips; a recommended option the factory names (the board card's "Recommended: <label>") is green (`--success`), never the accent. Archon's ask card keeps its own look (v2 direction).
2. **Text never leaves its box.** Every card, tile, chip and heading in the section wraps long unbroken text (paths, URLs, ids: `overflow-wrap: anywhere`, `min-width: 0` on flex and grid children) and clamps where the standard says; checked in the browser with a long unbroken path.
3. **The Factory tab has two pages: Overview and Board.** Its sub-navigation has no How it works (the sidebar Factory entry is that page). Old links keep redirecting.
4. **The board is tall enough to use.** At 1440x900 every column shows at least two full cards without scrolling the page; the work-order strip collapses to one line (expand on click) and the found-by panel stays one line.
5. **A stage opens in place, not on its own page.** Clicking a stage on the Overview map opens a large modal over the Overview (Esc and the backdrop close it; the map keeps its position and zoom). The modal says plainly what it shows:
   - "What this stage does": the view file's curated drill-down;
   - "Items here now": the items in the stage, linking to their item pages;
   - "The real workflow": the stage's steps read from the pack graph (v2 direction), behind a clearly labelled tab with one sentence saying where they come from.
   A failed read shows a retry, never a dead "Could not load".
6. **How it works moves and comes alive.** The sidebar Factory page is the only home of How it works. Its canvas shows the flow as a quiet, looping animation: three dots leave An issue, A work order and Found by agents and travel into Triage, on through Plan, Build, Checks and CI and reviews; there one dot goes on to Merged and one returns along the "unrelated finds" lane to Found by agents; the loop repeats. Off under reduced motion, pausable. Each kind on the canvas has its own colour: "A check on the change" and "What comes out" must differ.
7. **A look of its own, not the default.** The map and the How it works canvas get a considered visual identity: depth (soft shadow and a faint inner glow on cards), a subtle texture or grid on the canvas, light that follows the flow. Restraint is the rule: no neon, no heavy 3D, no motion that competes with the content, and nothing that slows rendering. If a treatment looks gimmicky at 1440x900 on a projector, it is out.

## Owner changes of 2026-11-18 (bind every later change; win over everything below, 2026-11-17 included)

From the owner's beauty review and the meeting with the pack's author (Rasmus) on 2026-11-18. The
goal: this stops looking like a proof of concept. It is what the owner presents on 2026-12-02, and
it goes to Archon `dev` as a draft PR for review, so everything stays generic (driven by the view
file, no pack names in code) and reads well to someone who has never seen Archon.

1. **"Merged", never "Landed", everywhere a person reads** (column, pill, numbers, timeline, How it
   works, work order strips: "3 of 5 merged"). Engine and pack ids keep `land` (`landgate`,
   `landed`); only the words a person reads change. An option id is never shown raw: a person reads
   the option's label.
2. *(Removed in the v2 direction: the Needs you tab, its order and the ask card are Archon's own, as on Archon dev; the factory section adds no Needs you page and no ask design.)*
3. **The board card is the approval card.** An item with an open ask shows its question and the
   recommended option on its board card, with a visible ping. Clicking it opens Archon's own ask
   section (v2 direction) in a popover over the board, answered in place, without leaving the
   board. *Amended by the owner on 2026-11-19 (#91), so the board fits its cards: such a card is
   short. Its title takes 2 lines; the question takes 1 line, with the ping and "N questions" on
   it. The popover holds the rest.* *Amended by the owner on 2026-11-24 (issue-171, v2): the
   card shows the newest question on its line, then the ask's declared recommendation as
   "Recommended: <label>" in green and how many asks are open ("N open asks"); with no
   recommendation declared there is no recommendation line. After an answer the card says
   nothing of it: the item page tells it.*
4. **Fewer board columns.** The view file groups stages into columns; the board draws one column
   per group, not per stage. For this pack: **Intake** (order, triage) | **Plan & build** |
   **Checks & review** (the check rounds, CI and PR reviews) | **Ready to merge** | **Merged**.
   Each column scrolls on its own; the page never grows with the longest column. A card still
   names its stage and step ("Checks · Code review · round 2"). The map still opens every stage on its own.
5. **Where the factory lives.** Factory-wide things (How it works) move to a **Factory** entry in
   the console's sidebar, next to Settings, one page per installed pack. The project's Factory
   tab keeps the live parts: Overview, Board, item pages and the stage modal. There are no step
   pages and no settings pages (v2 direction).
6. *(Removed in the v2 direction: shadow steps are not drawn, counted or explained anywhere. The land gate acts, and the factory merges on its "land", owner decision on #120.)*
7. **Send-backs and found work.** How it works draws several labelled lines going back (returned
   by checks, sent back by CI or review, replan, answered asks restart a stage) and "unrelated finds
   become new work" from the discoveries drain to intake.
8. **Later, not now:** reading engine-reported rounds and limits per item when the engine reports
   them instead of deriving rounds from events. (A settings page was built in #74 and is removed
   in the v2 direction: Archon issue #5317 owns pack settings.)

Not ours to build: forge views of issues and PRs (Thomas works on those in the existing UI), and a
YAML-to-graph generator (Rasmus has one: `GET /api/packs/{pack}/graph`, which is where the
section now reads structure). Our view and overview files stay the curated, simplified
presentation of it.

## Visual identity, 2026-11-19 (carries out owner change 7; binds the canvases)

Binds the Overview map, the How it works canvas (root and every drill-down) and the cards of the
stage modal's "What this stage does" (rule 2: one card language). The tokens live in
`packages/web/src/experiments/console/factory/factory.css`; the line constants in `factory/canvas-lines.tsx`.
They are checked in the browser, not pinned by tests (v2 direction: no test asserts a class or a
colour).

**Why the canvases looked generic.** Every card was the same flat box: one 1 px border, one
radius, a flat `--surface` fill, no light and no depth, so the cards read as outlines on a
hole. The canvas was a flat `--surface-inset` box. Every line was the same 1.5 px grey, so the
main flow did not lead the eye. The How it works flow dot was a 4 px off-white circle, easy to
miss on a projector. Intake on the map was purple.

**What is taken, and why each is not a gimmick.**

- **Depth.** `.factory-card` carries `--card-depth`: a 1 px inner rim `oklch(1 0 0 / 0.05)` all
  round (the 3 px accent bar covers the top edge, so it is not a top highlight), a 1 px contact
  line `oklch(0 0 0 / 0.4)` and a fall-off `0 6px 16px -4px oklch(0 0 0 / 0.55)`. A clickable
  card's hover takes `--card-depth-hover` (rim 0.07, fall-off `0 10px 24px -6px` at 0.65) and the
  `--border-bright` border; nothing moves. *Static and small: on a dark canvas a card needs it to
  read as a surface at all.*
- **Tint.** The fill is `--card-tint`: the card's colour mixed 7% into `--surface` under the bar,
  fading to `--surface` by 48 px. *It ties the bar to the card without colouring the text area.*
- **Light.** A map card that holds an item is lit (`data-lit`): `--card-glow`, a 1 px ring of its
  group colour at 30% and a glow `0 8px 28px -8px` at 45%. The Merged card is never lit: it holds
  every merged item for good, so its light would say nothing. A stage drill-down card with items
  on its steps (`data-running`) wears the running mark, the same as the loop pill
  beside it: `--running-border` and `--running-ring` (a 3 px ring); its tint stays its kind's colour. How it works has no live
  items; its light is the flow loop's glow round the card a dot rests on (rule 7). *Light
  carries information, where work is, and nothing else.*
- **Canvas.** Both viewports take `.factory-canvas`: `--canvas-texture`, a vignette
  (`radial-gradient` to `oklch(0 0 0 / 0.3)` at the edge) over a 24 px dot grid
  (`oklch(1 0 0 / 0.06)`, 1 px dots) on `--surface-inset`. The texture sits on the viewport, not
  the panned layer. *Two static background layers: no image, no filter, nothing repainted while
  panning, and the canvas reads as a surface.*
- **Lines.** A forward line is 2 px (`MAIN_STROKE`) with a gradient along the flow from
  `--border-bright` to `--text-secondary`, its head in the bright end. Send-backs stay 1.5 px
  dashed at 0.85 opacity (`BACK_OPACITY`); ask lines are unchanged. *The main flow
  leads the eye and the loops step back; no glow, no animation on lines.*
- **Type.** Rule 1's hierarchy on a card (kind 12 uppercase tertiary, title 15 semibold, text 13
  secondary) already holds. Only the map's live chips change, to `tabular-nums`, so a count does
  not jitter. *No new sizes.*
- **Colour.** Intake moves from `--node-prompt` (purple, hue 290) to `--tone-intake`
  `oklch(0.8 0.15 112)`, a lime 27 degrees from warning and 28 from land. The canvases' one
  accent use is the selected map card (a 2 px `--accent-muted` ring, the border unchanged); neither
  canvas, nor the stage drill-down's cards, has purple: the drill-down's Agent kind moves from
  `--node-prompt` to `--node-wait`, the teal How it works gives a stage. *Owner change 1: more green, purple and pink kept for one thing each.*
- **Flow dot.** How it works: a dot 10 px across with a halo 20 px across at 0.28 opacity (a second circle in
  the same moving group, not a blur), in the kind colour of the card it travels to. The glow round the card it rests on reaches 6 px out with a 12% fill. The
  map's dot is 10 px across in `--running` with a soft halo (`.map-flow-dot`; the legend's swatch,
  `.map-flow-swatch`, wears the same). *Presence on a projector (the #93 operator note), still
  only position and opacity animate.*

**Ruled out:** WebGL; SVG or CSS filters (blur, drop-shadow) on anything; noise images; animated
backgrounds; card lift or translate on hover. These tokens are named "depth", "glow" and
"tint".

## Visual standard (owner, 2026-11-18)

From the owner's beauty audit of 2026-11-18 (every Factory page at 1440x900 on a copy of the live
database): the section works but reads as a proof of concept. This standard binds every later
change that shows something and every check of one, and wins over every section below it. Where
it and "Owner changes of 2026-11-18" differ, the owner changes win. "The type floor" anywhere on
this page means rule 1's 12 px.

Tokens are named by CSS variable, with the Tailwind utility in brackets where one exists. They
live in two files: `packages/web/src/index.css` (`@theme inline`: `--text-console-*`,
`--radius-console-*`, `--tracking-console-*`; `:root`: `--node-command`, `--node-prompt`,
`--node-bash`, `--node-loop`, `--node-approval`, `--node-wait`) and
`packages/web/src/experiments/console/theme.css` (`.console-root`: surfaces, borders, text, accent,
status colours, `--node-script`, `--node-cancel`, `--node-opaque`); the canvases' identity is
the factory's own, in `factory/factory.css` (ConsoleApp imports it after theme.css):
`--tone-intake`, `--card-depth`, `--card-depth-hover`, `--canvas-texture`, the running mark
(`--running-border`, `--running-ring`), and on `.factory-card`
`--card-glow` and `--card-tint`). Where no token exists yet, a
rule names the Tailwind utility or the value instead; the list closing this section names those
gaps.

### 1. Type scale

Geist for everything a person reads; Geist Mono for workflow, step and key names.

| Role | Token | Weight, colour, tracking |
|---|---|---|
| Page title | `--text-console-22` (`text-console-22`) | semibold, `--text-primary`, `--tracking-console-heading` |
| Section heading | `--text-console-17` | semibold, `--text-primary` |
| Card title | `--text-console-15` | semibold, `--text-primary` |
| Body | `--text-console-14` | regular, `--text-secondary` |
| Meta | `--text-console-13` | regular, `--text-tertiary` |
| Label | `--text-console-12` | medium, uppercase, `--tracking-console-label`, `--text-tertiary` |
| Number tile figure | `--text-console-22` | semibold, `tabular-nums` |

- **Floor: nothing a person reads is under 12 px on screen at 1440x900.** `--text-console-9`,
  `--text-console-10` and `--text-console-11` are not used for anything a person reads. Their
  existing uses are fixed by the redesign items, not by this one.
- The floor holds on the How it works canvas at its fitted zoom. Its opening zoom and the Fit
  button never scale below the zoom at which the smallest canvas text renders at 12 px; with
  canvas text at 12 px or more, that zoom is 1.0. Where the drawing does not fit at that zoom,
  the canvas pans. A person may still zoom out by hand. The Overview's map is the exception
  (owner ruling 33a557aa, 2026-11-25): it opens fitted to its frame, down to a scale of 0.75
  (`LIVE_MIN_K`), so the whole row shows at 1440; a person zooms in to read closer.

### 2. Cards

One card language for the map, How it works, the board and stage drill-downs. Archon's ask card
keeps its own look (rule 9).

- Box: `--radius-console-12` (`rounded-console-12`), 1 px `--border`, `--surface` background.
  Hover: `--border-bright` border, `--surface-elevated` background. On the map, How it works
  and a stage's drill-down the box is `.factory-card` (factory.css) instead: depth, a top tint in
  its colour and light when it holds work ("Visual identity, 2026-11-19").
- Padding: 12 px (`p-3`); a drill-down card 16 px (`p-4`).
- A 3 px top accent bar in the stage group's colour (rule 5), inside the radius.
- Row 1: a 16 px icon and a kind label in the Label role ("AGENT · LARGE", as in 12-drill-build).
- Then the title in the Card title role, at most 2 lines; on a board card at most 3 (owner,
  2026-11-18: the board is where people find items, and a cut title costs a click).
- Then at most two lines of text at `--text-console-13`, `--text-secondary` (`line-clamp-2`).
- Live chips (rule 5's state colours) sit below the text.
- Minimum width on the map and How it works: **176 px**. A card is wider than tall (height at most
  its width; aim for 176-240 px wide by 120-176 px tall with every row present). A board card
  is as wide as its column.

### 3. Spacing

One 4/8 px grid: Tailwind's 4 px scale, every value a multiple of 4.

- Inside a card: 8 px between rows (`gap-2`).
- Between cards in a list or a column: 12 px (`gap-3`).
- Between canvas cards joined by a labelled line: 48 px, room for a label pill.
- Between page sections: 24 px (`gap-6`). Page padding: 24 px (`p-6`).
- Board columns: 12 px apart (`gap-3`), each at least 208 px wide (owner, 2026-11-18: five
  columns fit beside the sidebar at 1440x900, 5 x 208 + 4 x 12 = 1088 of 1100 px; narrower
  windows scroll sideways).
- The project tab row is Archon's, drawn as on dev with the Factory tab last (v2 direction).

### 4. Lines

- Stroke 1.5 px; 2 px when hovered or when the line belongs to the selected card. A forward line
  on the map and How it works is 2 px always ("Visual identity, 2026-11-19"). Bends have an 8 px
  corner radius.
- Arrowheads: a 6 px filled triangle in the line's colour.
- Labels: `--text-console-12` on a pill (`--surface-inset` background, 1 px `--border`,
  `rounded-full`, 6 px by 2 px padding). A label never sits on a line. A map hand-off's pill
  holds at most two lines (the map section says how a longer one reads).
- Forward lines: solid, a gradient along the flow from `--border-bright` to `--text-secondary`,
  the head in `--text-secondary`. A fan's short bar and stubs are solid `--text-secondary`.
- Send-back lines: dashed `6 4`, all in one colour, `--node-approval` (the colour the How it works
  lane already uses), at 0.85 opacity.
- Asks: dotted `2 3`, `--text-tertiary`.
- No line crosses a card, a label or another line.

### 5. Colour

- Group colours: intake `--tone-intake`, build `--node-wait`, check `--node-approval`, land
  `--node-script` (`factory/tones.ts`, which the board, the item page, the map and its
  legend all read). None is purple or pink, and each is at least 25 degrees of hue from the
  others and from `--running` and `--warning` (checked when a colour changes, not pinned by a
  test).
- Board columns (owner change 4): Intake takes intake's colour, Plan & build build's, Checks &
  review check's, Ready to merge land's, and Merged `--success`.
- A group colour appears only as the accent bar, the icon, the legend swatch, and on the
  canvases (and the item page's journey strip) a card's faint top tint and its light: never a
  solid fill or a text colour. The one exception is the
  send-back line (rule 4), drawn in `--node-approval`, which the item page's "Sent back" cells
  and send-back loops share;
  the legend tells it apart by showing it as a dashed line, not a swatch.
- How it works kind colours (`overview/overview-kinds.ts`): input `--node-command`, stage
  `--node-wait`, check `--node-approval`, a person `--node-script`, gate `--node-bash`, outcome
  `--success`. No two are less than 25 degrees of hue apart and none is purple or pink (owner
  changes 1 and 6 of 2026-11-19). Besides the uses listed below, a kind colour is a card's faint top tint, the
  faint glow the flow loop draws round a card while a dot rests on it, and the flow dot travelling
  to that card with its halo (rule 7). The check swatch shares `--node-approval` with the
  send-back lines, as the check group does above; the legend tells them apart the same way.
- State colours:
  - running: `--running` on `--running-soft`
  - needs you: `--warning` on `--warning-soft`
  - failed: `--error` on `--error-soft`
  - merged, done: `--success` on `--success-soft`
  - waiting: `--text-tertiary` on `--surface-inset`
  - parked: `--text-secondary` on `--surface-inset`, with a 1 px `--border` ring, so it reads
    apart from waiting while staying neutral
  - waits on you with no ask open (a declared `awaits` outcome): the needs-you colours,
    `--warning` on `--warning-soft`, soft like a chip: never filled and never the ping, which
    stay an open ask's
- A state pill or chip is the state's colour as text on its soft background.
- **"Needs you" is the one loud colour.** A card's Needs you state pill is the only filled pill
  (`--warning` background, semibold `--surface-inset` text), and only needs-you has the ping
  (rule 7). Chips that count needs-you (a column header, a map card) stay soft like the others.
- The brand gradient only where the console already uses it (the active tab bar).
- Components never write raw hex or oklch: they use `var(--token)` or the token's Tailwind colour
  utility.

### 6. States

- **Loading** shows skeleton shapes of the final layout, never the word "Loading" or "…". A block
  is `--surface-elevated` with `rounded-console-12` at the final card's size; a text line is a
  12 px bar at 60% or 40% width; a number tile shows a 22 px by 48 px bar. Skeletons pulse
  (`motion-safe:animate-pulse`).
- **Empty** shows a 20 px icon in `--text-tertiary`, one sentence at `--text-console-14`,
  `--text-secondary` saying what will appear here, and the most useful link at
  `--text-console-13` (for example "Open the board").
- **Errors** keep today's wording rules: the alert says what could not be read, and what is
  already drawn stays drawn.

### 7. Motion

- State changes: 150 ms, ease-out (`transition-colors duration-150 ease-out`).
- Running: `animate-pulse` on the running chip's dot only.
- Card moved: an `--accent-soft` background held for 1.5 s, then fading over 300 ms.
- Needs-you ping: `animate-ping` on an 8 px `--warning` dot.
- How it works flow (the overview's flow loop): SVG (SMIL) animation of position and opacity only,
  on one timeline per view, no frame loop and no filter; pausable. A dot's halo is a second,
  faint circle moving with it, never a blur. CSS cannot stop SMIL, so under
  `prefers-reduced-motion` it is not rendered at all.
- Every animation sits behind `motion-safe:` and is off under `prefers-reduced-motion`. There the
  moved highlight still shows for 1.5 s, statically, with no fade.

### 8. Words

- **"Merged" replaces "Landed"** everywhere a person reads: the column, the pill, "merged today",
  the map card, How it works, the item page, "N of M merged". Engine and pack ids keep `land`
  (`landgate`, `landed`).
- **An option id is never shown raw** on the factory section's own surfaces (Archon's ask card
  draws its options as on dev). A person reads the option's `label` when it has one, else
  the id in sentence case with hyphens as spaces ("send-back-once-more" reads "Send back once
  more"). The one exception is the reserved `other` option (label "Other"), which reads
  "Something else".
- Plain words, never raw enum values: "returned", "needs you", "round 2 of 3".

### 9. The ask and the column header

**The ask** is Archon's own ask section and answer panel (`ItemAsksSection`,
`AttentionAnswerPanel`, `ApprovalPanel`), exactly as on Archon dev, wherever the factory section
answers an ask (the board popover and the item page)
(v2 direction).
The factory section does not restyle, wrap, replace or parse it: its options, recommendation,
confidence and cost come from what the ask's workflow declares (#6139), never from the ask's
text. The factory's own surfaces that point at an ask follow the rules above:

- On a board card (owner change 3, as amended on 2026-11-19 and 2026-11-24): one line holding
  the ping and the newest question at `--text-console-13` cut to that line (the whole question
  on hover and in the popover); under it, at `--text-console-12`, "Recommended: <label>" when
  the ask's declared recommendation names an option (the option's label from the ask's own
  options, never read from its text), in green (`--success`), which wraps long unbroken text
  inside the card, and after it (on the same line where it fits, else the next) a neutral
  bordered chip reading "N open asks". The card's title then takes 2 lines, not 3.
- The popover that holds Archon's ask section over the board is at most 480 px wide; under
  520 px (a 390 px phone) it is a sheet from the bottom.

**The column header** (owner change 4), one per board column:

- A 3 px top bar in the column's colour (rule 5).
- Label: `--text-console-15`, semibold.
- Subtitle: `--text-console-12`, `--text-tertiary`, one line, truncated, naming the column's stages
  ("order, triage"). The Merged column's subtitle is "last 7 days".
- Count: `--text-console-22`, `tabular-nums`; a skeleton bar while it is not known (rule 6).
- State chips: `--text-console-12`, `rounded-full`, `px-2 py-0.5`, the state's soft background
  with the state's colour as text ("running 2", "needs you 1"). Only a state with a count above 0
  has a chip.
- Each column's body scrolls on its own.
- Empty-column placeholder: dashed 1 px `--border`, `--radius-console-12`, 96 px tall, holding
  rule 6's empty state ("Nothing in <column label> now").

### 10. (Removed in the v2 direction: shadows are not drawn, counted or explained anywhere.)

### 11. References

Read-only, outside this repository. Take layout and anatomy from them, never sizes: their canvas
text is under the type floor. Where they differ from the rules above, the rules win (12-drill-build
puts a card's accent on its left edge; ours is the top bar of rule 2).

- `C:\Users\colem\OpenSource\factory-mission-control\docs\design\v3\refs\20-board-pipeline.png`: the column header with label, subtitle, big count and
  state chips; "Merged, last 7 days"; the work order strip with "N of M merged" and its bar.
- `...\v2\refs\01-home-map.png`: the one-line map with the inputs on the left, labelled loops in
  lanes off the line ("fixes", "unrelated problems become new work"), the controls bar and the
  legend.
- `...\v2\refs\12-drill-build.png`: the kind label row above a card's title; labelled branch
  lines; a loop drawn as one labelled dashed line ("another round (max 2)"); a dotted line down to
  the card that asks you.

**Layout.** At 1440x900 the Overview shows its tiles, its one Needs you line and the top of the map in the first screen.
At 390x844 columns stack and the map pans.

**No token yet.** Spacing, motion (duration, easing), skeleton colour and icon size have no
console token; the rules above name the Tailwind utility or the value. Line strokes, dashes and
colours are constants in `factory/canvas-lines.tsx`; card depth, tint, light and the canvas
texture are tokens in factory/factory.css ("Visual identity, 2026-11-19"). A later change may add a token
when it first needs one, in the files named above.

## Owner changes of 2026-11-17 (bind every later change; win over older text below)

The section has **two separate things**, each with its own file:

1. **The factory overview** (new, its own page). A hand-curated explainer of how the factory runs, for
   presenting: not live, not exhaustive, never generated from workflow YAML. Its own file per pack
   (`.archon/packs/<pack key>.factory-overview.json`, or `<pack>/.shared/factory-overview.json`), in the
   format of Mission Control's `app/map/factory-map.json` (read-only reference at
   `C:\Users\colem\OpenSource\factory-mission-control`): views (a root view and drill-downs), groups,
   cards (title, one line of text, icon, kind), edges (feeds, calls, and "loops back" lines: as many
   as the factory has, nested in one lane under the line, each on its own track and labelled where it
   rises into its target, never crossing a card or each other (the schema refuses a file whose lines
   would; it does not measure labels, so the shipped file's test checks that its label pills meet
   nothing, and a pack author keeps a short line's label short); an answer to an ask is drawn
   beside the ask's line; changed by the owner's
   audit of 2026-11-18, which asked for several labelled send-back lines). Interaction like Eric Tech's
   skill map (https://erictechpro.github.io/super-board/skill-map/): a sidebar listing every view with
   counts and its one line, a breadcrumb, click a card to open its drill-down, a legend, pan/zoom/fit, a
   full-screen mode over the whole screen with the legend docked bottom-left. Style: Mission Control's curated map, beautified (the console's tokens), not a hand-drawn look.
   **The flow loop** (owner change 6 of 2026-11-19), on the root view only: dots leave every input
   card together (An issue, A work order, Found by agents) and reach the first stage (Triage) at the
   same moment; one dot then carries on along the forward line (Link, Plan, Build, Checks, CI and
   reviews, Ready to merge, Merged), resting a beat on each card while a faint halo in the card's
   kind colour shows round it. Where a send-back line returns to an input card, a second dot leaves
   at the same moment and travels it (CI and reviews, along "unrelated finds would become new
   work", to Found by agents), in its line's colour. The loop rests, then starts again. "On to Merged"
   passes Ready to merge, because the dots follow the lines the page draws. Which cards and lines
   it follows is read from card and line kinds (`lib/overview-flow.ts`), never from ids; a view with
   no single input line has no flow. Drill-downs and the other send-back lines stay still. A
   "Pause flow" control beside Full screen stops and resumes it (a pause holds across full screen
   and views); under `prefers-reduced-motion` neither the dots nor the control are drawn. Each dot
  is 10 px across with a faint halo 20 px across, in the kind colour of the card it travels to ("Visual
  identity, 2026-11-19").
2. **The live factory view** (what the Factory tab shows: Overview numbers, the Needs you line, the live
   map, Board, items, stages). Driven by the pack's **view file** (`factory-view.json`, below), which
   grows to carry, per stage, a curated drill-down (numbered phase columns of a few plain cards, each
   card `covers` the real step ids it stands for) and display names for steps. The check (The factory
   view declaration) fails on a step a card names that the pack graph lacks and warns on a real step
   no card covers. The live map
   is one row of stages with one feedback lane underneath; clicking a stage opens it.

**Step names, everywhere a person reads:** never a raw engine id such as `build__build` or
`rounds.review__review`. One function gives a step's display name: the view file's name when it has
one, else a cleaned id (a doubled include name collapses, a loop prefix becomes "round N", separators
become spaces). The raw id appears only on hover.

**Item keys, everywhere a person reads:** an item keyed `issue-N` (how the pack's `order-on-label`
binding keys an issue) or plain `N` reads `#N`: on cards, rows, titles, link text, sentences, hover
titles and accessible names alike. A split member, keyed `<order key>-<piece>` by the pack's
split, reads as its work order and its piece in words: `issue-136-item-keys` in `issue-136` reads
`#136 · item keys`. Which order an item is in comes from its `part_of` membership (its active link,
else its order run's result), never from the key, so a key that only looks like a member reads as
it is, and a member keyed by its own issue (`71` in `64`) still reads `#71`. A key reads as it is
where its order is not known: on the Runs page's pending-input banner, which reads no items; on an
item page whose item could not be read or found; and where a work order's own key names the order
("part of #136"). Any other key reads as it is. One function gives it (`factory/lib/item-key.ts`).
The raw key stays in every route, href, lookup, search and filter match, so `/items/issue-136`
still opens the item that reads `#136`. Where this document quotes `<key>` in words a person reads,
it means the key as it reads.

## What it is for

A factory is Archon running a pack of stages over work items: an item comes in, stages work it,
and it ends as a landed change, a question for a person, or a clean stop. Today the only way to
see one is a run list. This section shows the factory itself:

1. **What the factory is made of.** A map of its stages and how they hand an item on, that you
   can click into: a stage, then the workflow behind it and its steps, then Archon's own workflow
   page for a step's workflow.
2. **Where every item stands.** A board with one column per stage. Each item is one card that
   moves left to right as stages work it, and back when a check returns it.
3. **What needs a person.** The questions (asks) items are waiting on, answerable in place.

The first audience is a live room: on 2026-12-02 Cole teaches a four-hour bootcamp on building
your own AI software factory, and this section is the screen he presents from. Someone who has
never seen Archon must understand, from the map alone, what makes up the factory, and from the
board alone, where their own items are. Plain words over engine vocabulary, everywhere a person
reads.

It replaces a separate dashboard (Factory Mission Control, a Neon app). Two web UIs for one
factory confuse people; this lives inside the console instead. Mission Control's ideas carry
over (map, board, item timeline), its code mostly does not: it read a different pack's state
documents through Neon live queries.

## Rules every change follows

1. **Generic, driven by a declaration.** The console never names a pack's stages, workflows or
   nodes in code (`.archon/direction.md` §web-ui). What a factory looks like comes from a
   *factory view* declaration (below), and that declaration is presentation only: structure
   (stages, steps, outcomes, asks, arrows) comes from the pack graph, live state from the
   engine's generic item, run and attention reads. Code reads those three and nothing else, and
   never parses an agent's prose (v2 direction).
2. **The item is the unit; its position is derived.** Where an item stands is computed from its
   runs (the live run and its running step, else the last run's workflow and outcome), its open
   asks and whether its change landed. Nothing stores a column (`.archon/direction.md`
   §software-factory).
3. **Read-only engine additions, no migrations.** New server routes only read. No change to the
   database schema in this repository: the console reads tables the engine already has. The
   live factory and the console share one database.
4. **Console, not a new app.** Use the console's components, tokens (`theme.css`, the
   `text-console-*` and `radius-console-*` scale; `bun run lint` enforces them), the `useEntity`
   cache and skills layer, and the dashboard SSE for live updates. Copy patterns from existing
   pages (RunsPage, RunDetailPage, RunGraphPanel, MetricsPage) before inventing new ones.
5. **Live within 5 seconds.** When a run starts, changes step or ends, or an ask opens or
   closes, every Factory view that shows it updates within 5 s without a reload. A merge on the
   forge is no run event: while a change is not merged, the board and Overview ask about it
   every 30 s (not while the tab is hidden), so a merge shows within about two minutes.
6. **Never start a server on the live factory's home.** Use `bun run dev:console` (a throwaway
   home seeded with a read-only copy of the live database). See ENGINEERING.md.

## Where it lives

- Archon's own Console stays as on Archon dev (v2 direction): its project tabs and their order,
  its answer panel and ask card, and where it answers asks. The factory adds a project tab, a
  sidebar entry and their routes, nothing else.
- A last project tab, **Factory**, after Runs, Chat and Metrics. It shows only when a pack with a
  factory overview file lists the project among those a factory view of the pack applies to
  (`GET /api/factory/packs`, the cached read the sidebar entry already makes), so a Runs, Chat or
  Metrics page reads no view. A project whose pack has no overview file, or whose own view file
  is broken, gets no tab. Without one, nothing else changes.
- A **Factory** entry in the console's sidebar (`ProjectRail`), directly above Settings, for what
  explains a pack rather than a project (owner change 5). It shows only when at least one
  installed pack has a factory overview file, or a broken one. Its routes:

  | Route | Page |
  |---|---|
  | `/console/factory` | Redirects (replace) to the How it works page of the first installed pack whose overview file reads, in the server's order (by overview title, else key); when every listed pack's file is broken, the first, whose page says what could not be read. The packs read's install-wide problems (unreadable files, unreadable projects) show on the page it lands on. There is no pack index page (v2 direction) |
  | `/console/factory/:pack` | Redirects (replace) to `how-it-works` |
  | `/console/factory/:pack/how-it-works` | How it works: the pack's factory overview (`?view=<id>` opens a drill-down, full screen as before), under a header titled by the pack's name as a person reads it (the name part of `owner/name`, its separators made spaces, first letter upper-cased: "Archon software factory"; the raw id on hover; the overview's own title heads the map as the root of its breadcrumb), with a quiet "Source" toggle beside the title that opens the file it was read from (never a line of the header). `:pack` is the pack key (`owner.name` when installed). The page has no tabs and names no project (owner change 1 of 2026-11-23) |

  Which file a pack page reads: the pack's own `.shared/factory-overview.json` (bundled, global
  or installed) when it ships one; else the first project, by name, whose own files give one
  (`.archon/packs/<pack key>.factory-overview.json`, or a pack folder in its checkout), said on
  the page as "Read from a project's copy of the overview file" behind the header's Source
  toggle, the file's name shown and its path on hover; the project is not named. A broken pack file falls back to a project's file and its
  error stays listed on the page; a pack whose files are all broken shows only their errors.
  One read-only route lists all of this (`GET /api/factory/packs`).
- Routes, all under `/console/p/:projectId/factory`:

  | Route | Page |
  |---|---|
  | `factory` | Overview: one paragraph saying what this factory does, the numbers strip, the one Needs you line linking to the Needs you tab, then the map. `?stage=<id>` opens that stage as a modal over the map (The map, Click) |
  | `factory/board` | The board (default view Pipeline, with a Table alternative) |
  | `factory/items/:key` | One item: its story (header band, journey strip, a panel per stage with its rounds grid and asks), links and change. A key with no item and no work order says "There is no item <key> in this project" (rule 6) with "Open the board" and a search by key or title listing the closest items; a read that failed says why, with a Retry |
  | `factory/*` | Any other path: "No page here" inside the section, with links to Overview and Board |

- Inside the Factory tab a small sub-navigation, on the line of the view's title, switches
  Overview and Board, each its own route; the tab has no other pages (owner change 3 of
  2026-11-19). There is no Settings page and no step page (v2 direction): a step is
  plain text in its stage's list. How it works is the
  sidebar Factory page. Item pages have a back link to where you came from.

## The factory view declaration

A JSON file that maps a pack onto this section. The pack's author writes it, so a pack can
present itself without the console knowing it. It is **presentation only** (v2 direction): it
gives the graph's workflows, steps and outcomes words, a group and a position, and never restates
their structure. Validated with zod in `packages/workflows` against a presentation-only schema
(no stage-group enum in the engine; the schema is the owner, docs and examples derive from it).

What it carries, and nothing else:

- the pack title and summary;
- per board column and map stage: label, blurb, short name, which workflows (and, by name,
  which steps) it groups, its colour group, and its order (`stages`, `columns`, `map.cards`);
- map and How it works layout: positions, lanes, captions, edge labels, notes (`map.notes`);
- story wording: how each outcome reads (`story.outcomes`, `story.steps`, `story.said`), what
  choosing an ask's option starts (`answers`), and the words for a check round, a return, a
  parked item and a work order;
- optionally, which steps a stage modal highlights, by name.

What it never carries: step lists, outcome lists, arrows or ask flags (all from the pack graph;
`map.arrows` as the source of the map's arrows and `asked` go), shadow flags (`shadows` goes),
settings, a title rule that reads a run input's markdown (`itemTitle` goes), or any other copy
of a workflow's structure.

Fields the plan has not settled yet (`placement`, `endings`, `parked`, `awaits`, `retired`,
`landed`, `rounds`, `returns`, `approves`, `verdicts`, `change`, `partOf`, `discoveries`) stay as they are,
read as presentation only: each may shrink or move to the graph, none may grow, and no new
field of this kind is added.

**Discovery.** For a project, the console looks for, in order: the project file
`.archon/packs/<pack key>.factory-view.json` (a project may present an installed pack it cannot
edit), then `<pack>/.shared/factory-view.json` in any pack the project can run (project, global,
installed, bundled), the way metric views are found (`packages/workflows/src/metric-views.ts`).
A view applies to a project when the declaration is found and the project has at least one run
of a workflow the view names, or the project file exists. That is the switch Rasmus described:
enable the factory for a project and its view appears.

This repository ships the declaration for `Wirasm/archon-software-factory` as the project file
`.archon/packs/Wirasm.archon-software-factory.factory-view.json`, until it moves into the owner's
own copy of the pack (v2 direction). Its `story` field gives the item page one plain sentence per
outcome (#122). Its `retired` field names `deliver`, the one-workflow delivery the pack dropped
on 2026-11-23 (pack d7f8c36), kept only while old items need it to place: the Build stage lists
it, `placement` places its outcomes, `story.outcomes` words them and `change` reads its pull
request; `deliver` is drawn nowhere. Its `answers` field words what the pack's `drop` and `reshape` routes start, for the
workflows whose asks the pack binds them on.

**The check** (`bun run check:factory-view`, run in console CI; later shipped with the owner's
pack copy) loads the view file and the pack graph. It FAILS on any workflow, step, outcome or
option name the view uses that the graph lacks, on a drill-down step two cards cover, and on a
`map.arrows` label for a pair of stages the graph does not connect. It WARNS on graph workflows
or outcomes the view leaves unplaced, which is how a new stage (such as `link`) gets noticed,
on a real step no drill-down card covers, and on a drawn arrow with no label. It holds How it
works to the graph where the picture draws the pack's stages, without making it read the graph
or name a project: an overview edge between two cards that open a view stage must join two
stages the graph connects (FAIL), and a view stage that no card opens WARNS. It reads the graph from the pack itself, never from a committed capture: the pack's
repo and commit are pinned once, in `<pack key>.pack-pin.json` beside the view. Where a home is
named it reads the pack installed there and fails when that is at another commit than the pin;
in CI it fetches the pinned commit into a throwaway home. A `retired` workflow is not required
of the pack.

## Data

The items and the stage graph are the engine's own reads, which any API client uses:

- `GET /api/items/window?project=&since=&limit=&after=` (#5815) is the items read: a page of the
  project's items, each read whole (`ItemRead`). The console walks it from a far-back `since`
  (1970, so every item with a run shows) by its `after` cursor, which carries the window, 100
  items a page. The window lists an item once one of its own runs started, so an item whose
  first start is still queued for capacity, or that only a link or ruling created, is on no
  board, map or number until its first run starts; one linked `part_of` a work order counts
  only in that order's "N of M merged" (as not started). Showing those needs the window to
  count queued starts (an engine change), not a second reader here.
  The window pages by item id; the console sorts newest activity first (the latest of each
  item's runs' end, or start while one runs), since a board column keeps the order it is given.
- `GET /api/packs/{pack}/graph?codebaseId=` (#5848, what `archon pack graph` prints) gives the
  pack's stages, their steps, outcomes, whether they leave asks, and the arrows between them,
  each active (a trigger file in this install starts it) or only declared by the pack. `{pack}`
  is the pack's folder key (`Wirasm.archon-software-factory`), not `owner/name`. It is the one
  source of structure (v2 direction): the map's arrows, a stage's steps and outcomes and its
  asks all come from it, never from the view file.
- The existing item and attention reads give each item's runs and outcomes, its asks with the
  options their workflow declares (#6139), its links (work orders and members), and its change.
  The batched item-start read (`packages/core` `db/item-starts.ts`) stays.

Two generic reads, with no pack words, carry what the item reads do not (v2-D, #183):

- `GET /api/workflows/runs/records?runId=` (repeated, at most 100): each run's record without
  its events: status, its terminal record's `returns`, its node outcomes (each completed node's
  structured output), its loop iterations (bound, completed) and its running steps.
  `outputKey=` and `resultKey=` keep only the named top-level fields. The run detail route
  would send every run's every event; on a copy of the live project (91 items, 764 runs) this
  sends about 2.7 MB on a cold board load and only the running runs' records after it.
  The server keeps ended runs' records per process, and the web keeps them for the page's life.
- `GET /api/forge/subjects?codebaseId=` (`packages/server/src/routes/api.forge.ts`): an issue's
  title, state and URL (`workitem.view`), and a delivered change's URL, number and merge state
  (`pr.view`), through Archon's forge seam (`packages/adapters/src/forge-host.ts`). Items have no
  title column, and a merge on the forge is no run event. An item's title is its issue's, for a
  key that names an issue (`issue-<n>` or `<n>`, `lib/item-key.ts`); any other key reads as the
  key. No title is read from a run's input.

From them, the item reads, the graph and the view file's words, the web computes every item's
progress once (`factory/lib/run-facts.ts`, `item-progress.ts`, `factory-derive.ts`): its running
step, check rounds, returns, change, work order, and whether its last run parked it or left it
waiting on a person; the item page adds Archon's run detail for each run's models and step
starts (`run-story.ts`).

The view files come from **one small read-only route file**,
`packages/server/src/routes/api.factory.ts`:

- `GET /api/factory/views?codebaseId=` the factory views that apply to the project, found as
  the factory view declaration's Discovery paragraph says (through the generic
  `pack-declarations.ts` reader), validated against the presentation-only schema, with
  `packKey` (the graph's `{pack}`).
- `GET /api/factory/packs` every pack with a factory overview file across the install, for How
  it works: the overview its page shows and its files that failed; and the projects a factory
  view of the pack applies to, which gate the sidebar entry and the Factory tab.
- No route carries the pack's vocabulary: no rounds, returns, shadows, parked, discoveries or
  item story read in `packages/workflows` or `packages/server`. The web composes those from the
  generic reads and the view file's words. Placement and the board numbers are computed once, in
  the web, with no parity test.
- Whether a change merged comes first from the merge the engine recorded on the item (a land
  run records it, and `archon workflow merged` records one made by hand): a recorded item is
  merged at the recorded time from the first read, placed and counted without the change
  host, since a merge does not come undone and a restart then needs no lookup for it. Only
  when no forge record of its runs names the pull request does the server ask the host, once
  per process and in the background, for the number alone: the card shows "the change" until
  that answer fills "PR #n" on a later read. Otherwise it comes
  from the change host through Archon's forge seam (the same `pull request view` operation
  the packs use), read by the server and cached for at least 60 s. The server discovers forge
  plugins once per process (a plugin added after it starts needs a restart to be used here).
  Items merged before land runs recorded merges carry no record; record one by hand with
  `archon workflow merged` (the one-time backfill script of #141 went with the server read it
  used, in v2-D). The pull request is the one the
  run's forge records name, else the one on a branch the item's runs recorded whose URL is
  the change (an earlier run may have opened it). An
  empty change URL is no URL: the item takes the latest earlier run that named one. When no
  run named one but a delivery run returned an empty URL, the change is the first pull request
  found on the item's run branches, newest branch first, in the project's registered remote,
  and the item shows
  that pull request's own URL ("the change", unlinked, until the host names it). The
  browser never calls GitHub. A first lookup slower than the server's wait answers `pending`
  for that read only (never cached); the console reads again every few seconds while any item
  is pending. A lookup that failed answers `unknown` and is cached like any other answer.

All derivation (column, card fields) is pure TypeScript in the web package, with unit tests,
fed by these reads. Logic worth porting from Mission Control (`C:\Users\colem\OpenSource\factory-mission-control`,
read-only reference): `app/lib/board.ts` (placement and card fields), `app/map/live.ts`
(which card a running step belongs to), `app/components/FactoryMap.tsx` (pan, zoom, fit, details
panel). Port the logic and ideas, not the styling: Mission Control used its own tokens.

## Overview page

1. Title (Page title role) and the declaration's summary, clamped to two lines with More.
2. **Numbers strip:** items in flight (in a board column, not merged; the items set aside are
   not, see The board, Set aside), need you (the open asks and waits on the project's items and Archon's attention read's asks for
   the project, each once, and the items waiting on you with no ask open), merged today, merged in total ("N of
   M merged", M every item in a board column: not the items set aside, whether an ending took
   them off the board, they are parked or they sat idle), median time from first run to merged
   ("median to merged"). Each tile is a
   number tile in the card language: a 16 px icon and its label in the Label role, then the
   figure at `--text-console-22`. Until the items read first answers, each tile shows a skeleton bar
   (Visual standard, rule 6) in place of its figure. An item whose merge state is not known
   (pending, or unknown: the lookup failed or found no pull request, with no run working it)
   is in no number but M, never a count that may be wrong. While one is pending, every number
   but needs you shows the count of what is known with the skeleton
   bar beside it (rule 6: a skeleton is loading, and a pending state settles in seconds). An
   unknown one may never settle, so it gets no skeleton: a line under the tiles says how many
   in words ("1 merge state could not be read", `--text-console-13`), linking to the board
   narrowed to those cards (`?show=unknown`). A first read that fails replaces the tiles with
   an alert saying so; a refresh that fails says so above the last values read (as the map and
   the board do).
   There is no "found by the factory" tile (v2-D, #183): the drains name the items their findings
   concern only in prose, so a finding cannot be joined to an item by id. The tiles are plain figures, not links, with no hover or focus state (owner
   change 3 of 2026-11-23); each counts with the board's own show (`?show=`, one spec per show in
   `lib/board-show.ts`), so a number and the board agree. Only the unknown line under the tiles
   links (`?show=unknown`). The median tile's tooltip says what the figure means.
3. **Needs you:** one line, "N need you" ("1 needs you"): the project's open asks, the same count
   as the need-you tile and the Needs you tab badge, linking to the project's Needs you tab
   (`--text-console-13`, accent, underlined). No questions, recommendations or answering on the
   Overview: Needs you is drawn in two places only, Archon's platform-wide Needs you page and
   the project's Needs you tab (owner and Rasmus, 2026-11-25, #218). Nothing shows while the
   asks are read or when nothing waits, and the map follows right after.
4. **The map.**

## The map

Changed by #68 (owner audit of 2026-11-18): the board's columns, always one row, one clean lane.

- **One card per board column** (owner change 4): the view file's `columns`, in order, each
  card holding the stages of its column that `map.cards` lists, in the column's order; a
  column left with none is not drawn. Without `columns`, one card per stage, as the board. For
  the shipped file: Intake, Plan & build, Checks & review, Ready to merge, Merged. `col` and
  `row` on a card are accepted, so an older view file still loads, and ignored.
- **Always one row**, left to right. It opens (and Fit returns) fitted to its frame, down to a
  scale of 0.75 (owner ruling 33a557aa, 2026-11-25, over the earlier zoom-1 rule): the shipped
  map is about 1313 px wide, so at 1440x900 every card shows, Merged included. Where the row
  does not fit even at 0.75, the map opens at that scale at the row's start and pans sideways,
  so the flow reads left to right from Intake (owner ruling on #71).
- **Cards in the card language** (rule 2), 184 px wide and at least 168 tall, the height set
  by the card holding the most stages (216 for the shipped file, whose Intake holds Order,
  Triage and Link), every card one size so the lane under them is straight: a 3 px top bar in the group colour, the group's icon and kind
  label ("Intake", "Build", "Check", "Merge", "Merged"), then:
  - a card of one stage: the stage label (Card title role, two lines at most), its one short
    line (the stage's `short`, at most 24 characters; without one, its blurb clamped to two lines),
    and its chips on the bottom row. The whole card opens the stage.
  - a card of several stages: the column's label, then one row per stage, each opening its
    stage: the stage label with its "here" chip, and under it its short line (or blurb,
    one line), which the stage's needs-you chip takes the place of while one waits there.
- **Live chips** are rule 9's pills at `--text-console-12`: "2 here" (running colour with a
  pulsing dot while a run works an item there, rule 7; the waiting colour otherwise),
  "1 needs you" (soft, rule 5), and "checking…" in place of a count where a board column would
  show a skeleton bar for a pending merge state. The cards and arrows are drawn as soon as the
  view file and the pack graph are read (the map shows its loading shape until the graph is,
  which can take over a minute cold; the board and the item page never wait on it): until the
  items read answers each chip is a skeleton bar (rule 6;
  never "0 here", never "…"), and the chips fill in on the same cards when it does. If that
  first read fails, an alert above the map says so and the cards stay drawn with no chip, their
  details saying the items could not be read.
- The arrows are the pack graph's (`GET /api/packs/{pack}/graph`): its bindings between
  workflows and its outcomes (v2 direction), each drawn from the first stage listing its
  source workflow to the first listing its target, once per pair of stages. An arrow over a
  `depends_on` link (one that wakes the link stage on an item waiting there) moves no item and
  is not drawn, nor is one into a workflow no stage lists. The view file's `map.arrows` only
  labels a pair the graph connects; it never adds or removes an arrow. Direction comes from card order: an arrow into an earlier card is a send-back, into a later
  one a forward hand-off. Inside one card, an arrow to a later stage of the card is not drawn
  (the rows show that order); one into its own stage or an earlier one of the card is a
  send-back.
- **Forward hand-offs** run only between neighbouring cards: a short straight line at the
  cards' mid-height, its outcomes on one pill above the line (rule 4), one outcome per line
  ("build, narrow" stacks) up to two. Three or more read as the first and how many more
  ("built +2"), in the view file's words: the pill is then a button, and hovering, focusing or
  tapping it opens a tip listing every outcome, one per line. Each source stage's modal lists
  them too, under "Where items go from here". The gap between two cards is the pill's width plus 8 px each side,
  at least 48 px. A hand-off that would skip cards has no route of its own: its outcomes join
  the label of the hand-off from its source card to the next, as "<outcome> → <target card>",
  and where the graph has no such hand-off, one is drawn for it.
- **One feedback lane** under the row carries every send-back, dashed `6 4` in
  `--node-approval` (rule 4). A card has one source leg, near its right edge, and one target leg
  per stage of it something returns to, spread over its left half in its stage order. Each
  send-back drops from its card's source leg to the lane, runs right to left, and rises into
  its target stage's leg; every send-back into one stage shares that leg and one pill under the
  lane ("returned, sent back, answers" on Build, "replan, answers" on Plan). A send-back inside one card (an asked
  plan answered) is a short U from the card's source leg into its stage's leg. Where runs
  overlap they are one line, drawn once. Pills sit under the lane, each centred on its leg but
  never past the row's first or last card (a long label on Intake's leg starts at the row's
  left edge, where the map opens), on the first band down where it meets no other pill. Nothing crosses: no line crosses a card, a pill or another line.
- **Flow** (the map's addition to rule 7): while a run works an item on a card, a 10 px dot in
  the running colour, with a soft halo, travels along the hand-off into that card, over and over, fading as it
  arrives, where the running chip's pulsing dot holds it. The first card, with no hand-off into
  it, has none. Off under reduced motion.
- Pan by drag, zoom by scroll or buttons, Fit button; opens fitted.
- **Click** a card or a stage's row: the stage opens as a modal over the Overview (owner
  change of 2026-11-19, point 5). From md up it is centred and sized to its content by CSS: as
  wide as its phases (at least 640 px), The real workflow as wide as the graph it draws (so a
  one-step workflow stays compact; while the graph loads it is at its narrowest, then resizes
  once), as tall as what it shows, each at most 90% of the window. Its title and tabs stay put
  while the body scrolls under them. A size change snaps: CSS does not animate a size that
  follows the content. Under md it is the whole screen. The URL says which (`?stage=<id>`, pushed,
  so it can be linked and Back closes it). Esc, the close button and a press on the backdrop close it too;
  the Overview stays mounted under it, so the page keeps its scroll and the map its pan, zoom
  and open details panel. Focus moves to the close button, stays in the modal, and returns to
  the stage that opened it.
  Under the stage's label and blurb, "Where items go from here": one chip per arrow the pack
  graph has out of the stage into another, "<label> → <stage>", in the view file's words where
  it gives them (none when the graph has none). Then three tabs, and between the tabs and the open tab one
  notice about the items read, which every tab reads from: a failed first read says why with a
  Retry; a failed refresh says this stage shows the last items read, and why, with a Retry, so
  no tab passes old items off as here now and none glows a step from them; a slow read says it
  is trying again. No tab draws a notice of its own:
  - **What this stage does** (first when the view file gives the stage a drill-down), with the
    line "The factory's summary of this stage, from its view file.": numbered phase columns of
    plain cards, the loop as one labelled frame around the phases it repeats, a card glowing
    and naming the items on a step it covers now. A card is plain text: it links nowhere (there
    is no step page, and Archon's builder does not show pack workflows).
    A stage without one says it has no summary and that the real workflow shows its steps.
  - **Items here now**: the items in the stage that the board does not set aside (owner change 4
    of 2026-11-23), from the same read as the card's chips, each
    linking to its item page with its state (needs you, the run line of the run working it, or
    the board's merged, failed, waiting-on-you label, parked or waiting); rule 6's empty state
    when there are none.
  - **The real workflow** (first when the stage has no drill-down), with the line "Read from
    the pack's graph; shows every step.": the steps of each workflow the stage lists, from the
    pack graph, drawn by the section's one graph renderer (Archon's existing one where it can, v2
    direction) or as a plain list. A retired workflow still places its old runs in the stage,
    but the graph has nothing to draw for it. A step that is running now for any item is marked,
    and each item running the workflow is named, linking to its item page. A step is plain text;
    there is no step page. A failed read says which workflow could not be read and why, with a
    Retry button.
- A card's **details** button: a panel beside the map listing each of its stages in turn, with
  its blurb, the notes the view file places by it, the items in it (linking to each item), and
  the workflows behind it that the view has not retired (each opens the stage on "The real
  workflow").
- A legend under the map names the cards' colour groups in plain words ("Merging it",
  "Merged"), and draws each kind of line as the map does: solid, "Hands the item on"; dashed,
  "Sends it back, labelled where it returns to"; the running dot, "A dot moves along a line
  while a run works an item there".

## The board

Columns are the declaration's `columns` in order, each a group of stages (without them, one
column per stage), the Merged column among them; a card sits in the column holding its stage.
Placement of one item,
first rule that matches. The board, the map and the item page all place through one function
(`factory/lib/placement.ts`), so they never disagree:

1. A run of a declared workflow is **running** on it: the first stage whose `workflows` list
   the run's workflow (the view names no steps of a stage).
2. Its change **merged**: the Merged column. A view that held the item in Merged on its last
   read keeps it there while its merge state is pending or unknown.
3. Its last completed run's `workflow:outcome` is in `placement`, else its `workflow:*` (which
   also places a run that returns no outcome, such as the pack's `landgate`): that stage.
4. Its last run's outcome is in `endings`: not on the board; set aside (see Set aside below),
   its ending label saying why ("Closed by triage", "Folded into another item"), each linking
   to its item. The view maps each outcome by
   itself, never one wildcard over outcomes that mean different things (#100). A `parked` or
   `awaits` outcome is no ending: rule 3 places it (for this pack, triage's park and shape and
   close's reshape in Triage, in the Intake column; close's not_closed in Ready to merge), and the
   item counts as open (its item page and the Overview's need-you number treat it so; the board sets a parked one
   aside). Close's `dropped` is the ending "Dropped by you". Close's `not_closed` (the
   forge would not close or draft the PR) is `parked`, not `awaits`: once a person closes or
   drafts it by hand nothing the console reads would see that, so it must not count in Need you
   with no way out; its label says what to do ("The forge would not close the PR: close or draft
   it by hand"), which the Set aside list shows as its why.
5. Its last run **failed** or was cancelled: the first stage of that run's workflow, with the
   failed pill and stop line.
6. Otherwise the first stage.

A run that completed with an outcome neither `placement` nor `endings` takes is passed over by
every rule, so the item stays where its earlier runs put it: the link stage starts again on
every item that depends on one that ended, and on an item that was not waiting it ends `none`
and changes nothing. The check warns on such an outcome.

**Set aside** (#145). The columns hold live work. An item with nothing left to happen leaves
its column, counts in no column header, chip, In flight or M, and is no Table row; it folds
into one line under the board, "N set aside", in both views.
Opened (see The strips under the board), it lists each item's key (linking to its page),
title, why it was set aside and when its last run ended. An item is set aside when the first of these holds:

- an ending took it off the board (rule 4): its ending label is the why;
- otherwise, it is in a stage other than the landed one, its progress was read, and every run
  of it has ended (none running, pending or paused), it has no open ask, it does not wait on you (an `awaits` outcome: the Overview's
  need-you number counts it, so the board shows it), and no start is queued or held for it; and then either
  - its last run ended in a declared `parked` outcome: its `parked` label is the why, the run's
    reason on hover; or
  - its last run ended strictly more than 3 days ago and it never proposed a change, or its
    change's merge state could not be read (`unknown`, settled): "No change was proposed" or
    "Its merge state could not be read", after the stop line when that run failed ("Build
    failed at Writes the change; no change was proposed").

"Its last run" is the latest end of its runs; an item with no run, or with one not ended, has
none and is never set aside by the idle rule. The board reads the 3-day line on a clock that
ticks once a minute, so an item crosses it without a reload. It is computed from the current
read every time, nothing stored: a new run, an answer that starts one or a new order brings
the item back to its column at once. Placement is unchanged (the item page still says where it
sits), but the map, like the board, counts and lists it in no stage (owner change 4 of
2026-11-23; board and map decide it in one place, `placeItem`). An item set aside keeps its
position, so one that comes back does not
light as moved. The words are "Set aside", never archived or deleted: nothing is written to the
engine. An item placement found no column for (a view changed under cached items can cause
it) is not set aside: it keeps a folded "N position unknown" row at the end of the toolbar,
opening a list over the board.

**The strips under the board** (owner, 2026-11-23, #152). "N set aside" is one line under the
board, a one-line card, with a toggle after it, "show them" / "hide them" (the card language's
one-line form). "Found by the factory" went in v2-D (#183): its findings name items only in
prose, so they are not data the console can join (v2 direction). The list opens downward, in the page below the board or table, never over it: nothing is absolutely
or fixed positioned, the board keeps its fill height and the page scrolls to reach them. Above
md the board area is exactly the fill height (never under the Pipeline's floor with the
toolbar and the line), so a short window grows the page instead of running the board under the
opened strips. Switching Pipeline and Table leaves it open or closed as it was. With nothing set aside, there
is no line. It stays only while its data is generic (set aside from outcomes the view names; v2
direction).

A card, in this order:

1. Item key and state pill: **Running** (a run works it now), **Needs you** (it has an open ask),
   **Failed**, the declared label of an `awaits` outcome ("Needs shaping": its last run left it waiting on a person with no ask open; soft, rule 5),
   **Parked** (its last run kept it open for later: a declared `parked` outcome; it shows in a
   column only while a start waits for it, else it is set aside),
   **Waiting** (queued or idle between stages), **Merged**.
2. Title (from the item record or the forge, never read out of a run input's markdown; else the
   key), at most 3 lines; 2 on a card showing its open asks (rule 7).
3. The stage line, so a card names its stage inside a column that groups several. While a run
   works it: its stage, the running step's name and the round when the step is of the declared
   rounds loop, "Checks · Code review · round 2", linking to the run in the console
   (`/console/p/:projectId/r/:runId`); the step's engine id shows on hover. Otherwise the label
   of the stage it waits in ("Plan", "CI and review").
4. "part of <order>" when the item is a member of a work order (see Work orders).
5. "round N of M" when a declared rounds source has a round on the item: the latest iteration
   of the deliver loop, or, on the three-stage delivery, the newest `stage-check` run's round
   and allowance from its result (so M can be 4 after a one-more-round answer), with one dot
   per round coloured by that round's verdict: approved (a declared approval), returned (a
   declared return), needs a decision (neither: an ask or a replan), running. A `stage-check`
   run going now has no number until its result names one, so the card adds a running dot
   and reads "round N of M, next one running" ("first round running" before any).
6. "returned ×N" when checks or the host sent it back, linking to the item page; then the
   change: "PR #123" linking to it, when there is one. When the change host could not say
   whether it merged, the card says "merge state unknown" rather than reading as unmerged;
   while the server is still asking, it says "checking merge state", and the column holding
   it and the Merged column show a skeleton bar (Visual standard, rule 6) instead of a count
   and no state chips; an empty column in that state shows skeleton cards, not its empty
   placeholder. Either way the card sits where its runs put it, except that a card already in
   Merged stays there: it never moves back to a stage it left because an answer is missing.
7. For a failed item: one line saying what stopped it, naming the stage rule 5 places it in and
   the step it failed at ("Build failed at Writes the change"; a cancelled run "Build was
   stopped"), never the workflow id. The item page's story says the same sentence. For one waiting on you with
   no ask open: the first question its run recorded, cut to its line, and "N questions" when it
   recorded several, else its reason. For one with open asks (the item read's questions and the
   asks Archon's attention read names on the item, each once by ref, `itemOpenEntries`): one
   control, the ping and the newest question cut to one line, and under it "Recommended: <label>"
   in green when the newest ask declares a recommendation, then a neutral bordered chip reading
   "N open asks". It
   opens the item's asks in a popover over the board, 480 px beside the card from md up and a
   sheet from the bottom under md: Archon's own `ItemAsksSection` for the asks answered by ref,
   and a paused run's wait in Archon's `AttentionAnswerPanel` or `ApprovalPanel`, as dev's
   pending-input banner draws them; a run it cannot answer links to its run page. Esc or a press
   outside closes it; focus returns to the card unless the press landed on another control. An
   answered ask stays in it as Archon's section shows it ("Answered: <label>") until it is
   closed, and the card's count drops at once. A merged card keeps its compact form and no ask
   control.

A merged card, in the Merged column, is compact: its key and pill, its title, then the change
and when it merged, in local time; no stage line, order chip, rounds or returned count. The
Merged column lists the items merged in the last 7 local calendar days, newest first, then
"N earlier · show all" opening the Table filtered to merged. A column with no card to show says why: "No card here
matches the filter" under the filter box or `?show=`, "Nothing merged in the last 7 days" for
a Merged column holding only older merges ("No match merged in the last 7 days" when the filter
matches only older merges), else rule 9's "Nothing in <column> now".

A card is as wide as its column, and columns follow the Visual standard (rules 3 and 9); where
the columns do not fit the width, the board scrolls sideways with a hint naming the hidden
columns, at the end of the toolbar. The Pipeline's toolbar (the filter box, Pipeline/Table, a
`?show=` chip, the Position unknown row, the hint) is one line at 1440x900.
At 1280x720 it is one line on a board with no `?show=` chip; a `?show=` chip can push its last
parts (the Position unknown row, the hint) to a second line. On a phone it wraps. The work
orders' section sits between the toolbar and the columns (see Work orders); in a short window
the columns keep their floor and the page scrolls. The
columns take the rest of the window. A card opens the item page, except its links and its ask control. **Table** view: one
row per item in a column (the items set aside are no rows) with the same fields as columns, a Work order, a Column and a Stage column among
them (a running item's step and round under its stage, as the card's stage line reads; a merged
item's Stage empty, as its card names no stage; Merged as
a short local time, the full one on hover), sortable; a row with open asks has an Answer button beside its state pill opening the same popover. A filter
box narrows by key, title or work order key, matching the raw key (`136` finds `issue-136`). The
Item and Work order columns sort by the key as it reads, so `#9` comes before `#111` whichever form
each is stored in. A key never breaks inside itself (`#136 · pack view` is one line): its column
grows and the title wraps instead, down to 128 px, so a member key costs the other columns as
little room as it can. Where the rows still need more than the window gives (a long round or
ask column), the Table scrolls sideways. Until the items are read, the board draws its
declared columns with skeleton counts and card shapes (Visual standard, rule 6).

**Work orders** (read-only; the console records and ends no link). A work order is an item other
items are `part_of`. An item's order is its newest active `part_of` link, else the order its
newest run of the declared `partOf` workflow that completed with its declared outcome names (a
refused order run never makes an item a member): a link wins over a result that
disagrees (`factory/lib/work-orders.ts`). An order with no run of its own is no card in any
column and counts in no number; its members count as the items they are. Above the Pipeline's
columns, under the toolbar, a section of the board lists the work orders with a member on the
board (one that has a run), at the board's text size. Its header reads "N work orders · M open"
(open: not every member merged) and folds the list; while an order is lit it adds "highlighting
<key>" with Clear highlight, so a card's "part of" link lights something visible even with the
list folded. The list is open by default and holds about three rows before it scrolls, one row
per order: its key and title (its own when it has one, else "Work order <key>"), "N of M merged"
with a small bar, one dot per member in its pill's colour, and Highlight members, which lights
its members on the board and dims the rest (`?order=<key>`) without leaving the board. The rest
of the row opens the order's item page, with a hover state that shows it. An order whose members have not started has no row yet: the order
and its members show on its item page (`factory/items/<order key>`). A member's card says
"part of <order>", which lights its order. An
order's own column, stages and landing target are not built (owner ruling of 2026-11-17).

When an item changes column, the card moves there within 5 s; a brief highlight shows it moved.

## The item page

A document page (owner change 5 of 2026-11-21) that tells the story of one item (owner change
8). It is the item's ONE history (v2 direction): the story panels, the rounds grid inside its
Checks panel and the asks where they happened are one account, and no other page keeps a second
history of the item. It has a header band and the journey strip across the full width, then the story in the main
column and the item's records in the aside. At 390 px the strip scrolls sideways and the
panels stack. Everything on it is derived in `factory/lib/` from the item read and the view
declaration: where the item went (`item-visits.ts`), the strip (`item-journey.ts`), the panels
and their sentences (`item-story.ts`), and the rounds grid (`item-rounds-grid.ts`).

- **Header band:** the key as it reads (`#N`; any other key after a `#`) and the title, the state pill the board card shows (the band's one
  coloured state), the change as a button-style link ("PR #n") with its merge state as quiet
  tertiary words after it ("merged", "open", "merge state unknown"; a skeleton line while the
  host is still asked), one sentence of where the item is ("In Checks now.", the `endings`
  label, the `awaits` or `parked` label with the reason its run gave, "Its change merged."), and stat
  chips: the time from its first run to its merge ("order to merge"), to where it stopped, or
  to now; its cost; "N of M check rounds" from the board's round; and how many asks were
  answered. An item no run has started yet (a member linked before its first run) says "Not
  started" instead, with no chips; a work order with no run of its own says it is a work order.
- **Journey strip:** one segment per board column, in the column's colour, with the time the
  item spent there (every visit together), or "Not reached". Where it was comes from each
  stage its runs worked, as their steps started, and from where `placement` left the item when
  each run completed, so the strip, the board and the story place alike. The column its board
  card is in now is lit as the map lights a card ("It is here now"); for a merged item, Merged.
  Each move into an earlier column is counted on the column it left, as a dashed loop in the
  send-back colour, "sent back 2x to Plan & build". Each ask it waited on is a pause on the
  column the asking run left it in, "waited on you 12 min" (to now, in the needs-you colour,
  while the ask is open). An item that was parked, waits on you, ended, failed or held ends where
  it stopped, saying so ("Stopped here: Parked by triage", "Stopped here: Needs shaping"), and its time ends with its last run.
  Held, as the page can see it: its last stage run asked, every ask is settled, none is open,
  settling them started no run, and no start waits for
  one either (none queued for a slot, none kept back by the install hold). The answer's route
  is not on the item read, so it reads what is known: "Nothing started after your answer". The
  band says the same ("Nothing started after your answer, in Build."). A merged change wins:
  the strip then lights Merged.
- **The story:** one panel per stage visit in the order it ran: a stage the item met again is
  its own panel, numbered ("Plan (2)"). A run works the first stage that lists its workflow. A
  build visit between two visits of one check stage is that stage's fix and folds into its
  panel, so build and check ping-pong (a stage-form delivery's runs, or a loop's fix step) reads
  as one Checks panel. Each panel has a 3 px bar and a section heading in its board column's
  colour (the column's label as the eyebrow, the stage as the heading) and opens with one plain
  sentence of what happened:
  - a run not finished, in the stage's name: "Build is working on it now: Writes the change",
    "Plan is waiting to start", "Plan failed at <step>", "Plan was stopped". On the Merged
    stage, whose name is an outcome, the factory is the subject, after the merge: "The change
    merged; then the factory failed at <step>";
  - a Checks panel with rounds, from its rounds: "Checks sent it back twice, then approved it",
    "... then asked you", "Checks approved it";
  - else the view's `story` sentence for the panel's last run: `story.outcomes` when this is the
    last stage the run worked, `story.steps` (by the step it started the stage on) for an
    earlier one, and, when the view tells neither, a neutral sentence: "Plan finished: sent to
    Build", or the pack's token in mono.
  A run that works several stages tells what concerns the whole run (that it is running,
  failed or was stopped, the asks it left and what you answered, why it sent the item back)
  only on the panel holding its last position; its earlier panels say what it
  did on their stage ("Build wrote the change").
  The console adds only clauses about its own concepts: " and opened PR #n" on the panel of the
  run that named that pull request first, ": <why>" when the panel ended by sending the item
  back and its last run has finished (the returning round's summary, else the run's words at
  `story.said`, cut to a sentence of about 140 characters with the rest behind "More"; while a
  new round runs, an earlier round's reason stays under the grid only), and "; you said
  <option>" when the panel's last run asked and was answered. Then its details as a definition
  grid: when, how long (the panel's own stretch of a run that works several stages), cost, the
  models its runs recorded, and each run linked. A run records one cost for all its stages, so
  on such a run's panels the cost reads "for the whole run, across its stages", or "for its N
  runs, across their stages" when the panel holds several.
- **Check rounds as a grid:** in a Checks panel, a table whose columns are the rounds (a
  loop-form delivery's iterations, or one per stage-form run). Stage-form runs are numbered by
  their order on the item since it was last planned, the count starting over at a run on an
  intake-group stage; never the number a run recorded, which can repeat. A loop-form run
  numbers its own iterations from 1, matching the board card, the header band and the server.
  Each column is bounded by the allowance its round's run recorded: "Round 4 of 4". When an
  item has more than one loop-form delivery run, each such column is prefixed with its run:
  "Delivery 2 · round 1 of 3". The reasons under the grid take the same numbers. The rows are:
  each step with a declared meaning (`returns`,
  `approves`, `verdicts`), named as the view names it, in the order the view's `steps` lists
  them; the builder's fixes (a loop's fix step, or a folded build run), in the column of the
  round they answered; the next check stage's runs (CI and the reviews), stacked in the last
  round's column. Each cell is an
  icon and a word in its colour: "Sent back" in the send-back colour, "Approved" in success,
  "Asked you" in needs-you, "Fixed" neutral, "Not run" tertiary with a dash; an outcome the
  view does not word stays the pack's token in mono; the step's id and what it said are the
  cell's hover. A one-line legend above it says what "Sent back" and "Approved" mean; under
  it, each round that sent the change back says why in one sentence, the full text behind
  "More". A step whose outcome only restates the verdict has no meaning declared and no row.
- **A panel that went round without a grid** (CI and the reviews sent the change back, the
  builder fixed it, they looked again) lists, under its sentence and before its last run, each
  send-back with its reason ("Sent back: <first sentence>", the rest behind "More", from the
  run's words at `story.said`) and each folded fix in the view's words ("Build fixed what CI and
  the reviews raised"). Its sentence tells how its last run ended.
- **Asks in the story:** an answered ask sits in the panel of the run that asked it (its last
  panel, for a run that works several stages): the
  question, "You said <option>" with the option's id as a tag and its own words, who answered
  and when, and what that started ("Build started again", the stage of the run whose cause
  names the settled asks, else "Nothing started"; the view's `answers` sentence for the option
  when it words one, as "Leaves the PR as a draft until the item is shaped"). The item's open
  asks wait on a "Waiting on you" panel at the top of the story, in Archon's own ask section (and
  answer panels for a paused run's wait), as on dev, answerable in place. An
  item waiting on you with no ask open (its pill is an `awaits` label) opens its story with a
  panel of its own in the needs-you colour, without the ping: the label as its heading, the
  reason its run gave, the view's `next` sentence under "What to do", and "Questions to
  settle", one per row.
- A run of the `discoveries` drain, on no stage, is a quiet panel of its own, "Found by the
  factory", in start order (only while discoveries come from generic data, v2 direction).
- **Merged:** the Merged stage's panel gives when the change merged; when no run of that stage
  tells it (a person merged it), a last panel says only "The change merged <time>", never that
  the factory merged it. Only the view's sentence for a landing run says the factory did.
- **Aside:** Links (depends on, part of, duplicate of, from the engine's item links; a member
  its order run placed without a link says "Part of <order>, as its order run recorded"; on a
  work order, its members stand for their links: each with its title, state pill and where it
  sits, under "Members: N of M merged") and Rulings and answers given on the item, each on a
  panel. An order with no run of its own has no column or state; without a title of its own it
  reads "Work order <key>". An order only a result names has no item row: its page is its key,
  that title and its members, from the items read.

## Testing

- Tests assert behaviour a person sees and can do: where an item is placed, what a count says,
  what a link opens, that an answer is sent. No test asserts a CSS class, a colour, a token, a
  size or an exact sentence of copy; the Visual standard is checked in the browser, not pinned by
  tests (v2 direction).
- Test lines stay at most half of source lines across what the console adds. A fixture is kept
  only while a test reads it, and is the smallest slice of a real run that shows the case.
- Pure derivation (placement, card fields, map live chips, declaration parsing) has unit tests
  with `bun test`, with fixtures copied from real runs of the live factory.
- Each route has a server test in the existing harness style.
- Every change that shows something is checked in a browser before it is called done:
  `bun run build:web && bun run dev:console`, then drive it with `agent-browser` at 1440x900 and
  at 390x844 against the Visual standard. The pull request describes what you saw and says which
  of the standard's rules (by number) it touched.

## Later (not in the first slices, written down so they are not lost)

1. **Work orders' own column and landing target** (`docs/shape.md` in the pack: hypothesis
   today). The strip, member chips and order pages are built (#47); an order's stages, landing
   branch and any write from the console belong to the pack and engine.
2. **Graph view of the board** (Rasmus's preference): items as a graph by links instead of
   columns, as a third view.
3. **Pool of machines** (Rasmus's idea): one console observing several Archon daemons.
4. **Manager:** a Claude Code session with the factory skill as the operator, local or over SSH;
   the console stays the observation pane.
5. **Upstream:** a slim pull request to Archon dev (v2 direction), and the view file moved into
   the owner's own copy of the pack, read from there.
