---
title: The Factory tab
description: What the console's Factory tab shows, and how a workflow pack declares the factory view it draws.
category: guides
area: web
audience: [user]
status: current
sidebar:
  order: 16
---

A pack that runs work items through stages (an issue comes in, stages work it, and it ends as
a landed change, a question for a person, or a clean stop) can present itself in the web
console as a factory. The pack's author writes a *factory view*: a JSON declaration that names
the pack's stages, the workflows and steps that work each one, and which outcomes move an item
where. The console reads it beside the engine's own records. It never names a pack's stages,
workflows or steps in its own code.

## What the tab shows

Every project, factory or not, has a **Needs you** tab, left of Runs, with how many asks and
paused waits need a person on it, and, on a project with a factory view, the items an `awaits`
outcome left waiting on a person with no question open. It opens with a band saying how many
wait, how long the oldest has waited and how many were answered today. Those items are listed
under **Waiting on you**, each with its label, its reason, what to do (the view's `next`) and the
questions to settle, linking
to its item page. It lists every open question on the
project's items and runs, from any workflow, grouped under their item on a panel marked in the
needs-you colour, each under the stage that asked, as an ask card:
the question, its context, and one tile per option saying what it does and costs, the
recommended option first and marked, with why. An ask a stage left with no recommendation marks
no tile and says why where the recommendation would be ("The stage could not choose: <reason>").
An option the factory view's `answers` words also says what choosing it starts ("Closes the PR
without merging"). Choosing a tile does not send: a confirm row says "Answer: <option>", and **Confirm** answers it in place; the card then says what it was
answered with for a few seconds. A stage waiting for an event past its deadline is listed
apart, under **Paused**, with what it waits for. Beside them, **Answered lately** lists the
newest answers, one row each: the question, the option chosen, who answered and when, and the
stage (or, on a project without a factory, the workflow) that settling the item's asks started
again, linking to that run, or "Nothing started" (a run started by hand after them is not one).
An answer whose option `answers` words reads that sentence in place of the stage.
With nothing open, the tab says so, when something was last asked, and links to the runs (and,
on a project with a factory, to the board).

A project gets a **Factory** tab after Runs, Chat and Metrics when a factory view applies to
it. Its sub-navigation, on the line of the view's title, has three pages: **Overview**,
**Board** and **Settings**. Needs you is the project tab beside it, and How it works is the pack's page under
**Factory** in the console's sidebar. Inside the tab:

- **Overview**: the view's title and summary (on a phone, its first three lines and **More**),
  then a strip of numbers (its **need you** number is the Needs you tab's count), then the
  newest three asks as compact cards, the question and the recommended option, each with
  **Open**, which answers it on the Needs you tab, and how many more wait there. Then **the map**: one card per board column (one per stage
  when the view declares no `columns`), in one row, always. A card of several stages lists each
  as a row. A card shows its group's colour, icon and kind, each stage's label and `short` line,
  and chips for how many items are there now ("2 here", its dot pulsing while a run works one)
  and how many need a person. The map counts what the board counts: an item the board sets
  aside is in no card's count and in no stage's "Items here now". The arrows are the ones `map.arrows` declares and no others. A
  forward hand-off is a short line between neighbouring cards, labelled on a pill. Every
  send-back (an arrow into an earlier card, or into its own stage or an earlier one of its card:
  a return, a replan) runs dashed in one feedback lane under the row, with one pill per stage it
  returns to. While a run works an item, a dot travels along the hand-off into its card. The map
  draws its text at full size, so on a screen too narrow for the whole row it pans sideways,
  opening on the card with the most items in flight. Drag to pan, and scroll or use the buttons
  to zoom; **Fit** goes back to how it opened. Click a card, or a stage's row, for its stage
  page. A card's details button (ⓘ) shows each of its stages' items and workflows beside the map.
- **Board**: one column per declared `columns` entry (one per stage when the view declares
  none), each item one card in the column holding the stage it is in. The board fills the
  screen and each column scrolls on its own under a header with its label, its `blurb` ("last 7 days" on the column holding the `landed` stage), its
  count and a chip per state ("running 2", "needs you 1"). A card names its stage, or the
  stage and step running now ("Checks · Code review · round 2"), and shows the item's state
  (Running, Needs you, Failed, the label of an `awaits` outcome such as "Needs shaping", Parked,
  Waiting, Merged), the round it is on, how often checks sent it
  back, its pull request, and the work order it is part of. The column holding the `landed`
  stage lists the items merged in the last 7 days (local time), newest first, with "N earlier
  · show all" opening the Table filtered to every merged item; its cards are compact (key,
  title, pull request, when it merged). On a phone the columns stack and each shows its first
  three cards, with "show all N" for the rest.
  A **Table** view lists the same fields as sortable columns, the stage and the board column
  among them. The filter box finds an item by
  key, title or the key of its work order.
  A **work order** is an item other items are `part_of`. An item's order is its active `part_of`
  link (`archon workflow link --item <member> --kind part_of --to <order>`), else the order its
  latest run of the `partOf` workflow that completed with its declared outcome named (a refused
  run never makes it a member); a link wins. Above the Pipeline's columns, a **Work orders**
  section lists the orders with a member on the board under a header that counts them ("2 work
  orders · 1 open"; open means not every member merged) and folds the list. Each row shows the
  order's name (its own title, else "Work order <key>"), how many of its members merged ("3 of 5
  merged") and each member's state as a dot; clicking the row opens the order's page.
  **Highlight members** lights its members on the board without leaving it; a member's "part of"
  chip does the same. While an order is lit, the header says "highlighting <key>" with **Clear
  highlight**. An order is listed once one of its members has a run; until then the order and its
  members, each "Not started", show on the order's item page (`/factory/items/<order key>`). An order with no
  run of its own is not a card and counts in no number. The console shows links; it never
  records or ends one.
  Under the board, in both views, sits one line holding **Found by the factory** and **Set
  aside** with one toggle, **show them**, that opens both together below the board or table,
  never over it: the board keeps its height and the page scrolls to them. Switching Pipeline and
  Table leaves them open or closed.
  When the view declares `discoveries`, **Found by the factory** is on that line whatever the
  filter ("14 the factory would file", with its shadow badge); the toggle, or a board
  address with `?show=found` (which also scrolls the line into view), opens the full panel: how many findings the discoveries drains decided to file
  that no item on the project carries yet (an item carries one when its title is the finding's,
  ignoring case), with chips counting every finding they decided to file, held and dropped,
  and how many are already on the board, then each finding: its kind, its title,
  the item whose drain decided it and when, and how the drain verified it, on hover. While the
  view marks the drains `shadow`, its line carries a "shadow" badge and the panel says the
  factory decides what it would file and files nothing yet. The panel only reads: it files, starts
  and dismisses nothing.
  Beside it, the columns' items with nothing left to happen fold into **Set aside** ("3 set
  aside"), which the toggle opens to list each item's key, title, why it was set aside and
  when its last run ended. An item is set aside when an `endings` outcome took it off the
  board, when its last run ended in a `parked` outcome, or when its last run ended more than 3
  days ago and it never proposed a change (or its change's merge state could not be read);
  never while a run works it, it has an open question, an `awaits` outcome leaves it waiting on
  you, or a start is queued or held for it. It is a reading of the items, not a state: nothing
  is stored or written, and a new run brings the item back to its column at once. An item set
  aside counts in no column, not in flight and not in M; an open question on it still shows in
  Needs you.
- **Item page**: the story of one item. A header band gives its number and title, its state
  pill, its pull request, where it is (a parked item reads its declared `parked` label and its
  run's reason, an item waiting on you its `awaits` label and reason) and its key facts: the time from its order to its merge (or to now), its cost,
  the check rounds used of those allowed, and the asks answered. A journey strip shows its path
  through the board's columns with the time it spent in each, the column it is in now lit, each
  send-back to an earlier column as a loop with its count, each ask it waited on as a pause,
  and where it stopped when it was parked, waiting on you, ended, failed or held (every ask it left answered,
  and nothing started after the answer, nor waits to: "Nothing started after your answer"). Then the story: one panel per
  stage visit in the order it ran (an item waiting on you opens it with a panel saying what it
  waits on, what to do and the questions to settle; a stage met again is numbered, "Plan (2)"), each opening
  with one plain sentence from the declaration's `story` (the console adds the pull request a
  run opened, why the checks sent it back, and what you answered), then its details (when, how
  long, cost, models, runs). A run that works several stages tells its status, its asks and
  why it sent the item back once, on its last panel. A build that fixed what a check sent back
  folds into that check's panel. A Checks panel shows its rounds as a grid: a row per check whose outcome the
  declaration means (`returns`, `approves`, `verdicts`), the builder's fixes, what CI and the
  reviews said after the last round, and the shadow steps' decisions; a column per round, numbered by its order since the item was last planned and bounded by the allowance its run recorded; each
  cell an icon and a word ("Sent back", "Approved", "Fixed", "Not run"), with a legend and, for
  each round sent back, why in one sentence (the rest behind "More"). An ask sits in the panel
  of the stage that asked it: the question, the option chosen, who chose it and what that
  started; an open one as the ask card, answerable in place. Beside the story: the item's
  links to other items (on a work order, its members with their state and how many merged; an
  item no run has started yet says "Not started") and the rulings and answers given on it.
  An outcome the declaration does not tell reads as a neutral sentence from `placement`,
  `endings`, `awaits` and `parked` ("Plan finished: sent to Build"), or the pack's own name for it.
- **A stage**, opened over the Overview map: what it does, told as its drill-down when the view gives one: numbered
  phases of plain cards, a card glowing and naming the items on its steps now, and a click on a
  card listing the real steps it stands for, each linking to its step page. "Show the real
  steps" (or, for a stage without a drill-down, the modal itself) draws the step graph of each
  workflow behind it: every step at full strength, the stage's own steps ringed in its colour
  and tagged "This stage", each other step tagged with the stage that works it (a click opens
  that stage on its real workflow), and a step running for an item now glows.
- **Step page**: the step by its name, with its engine id under it, the items on it now, when
  it runs (its `when:` in words, such as "if Verdict = return", the expression on hover), its
  prompt, its YAML and the model it runs on.
- **Settings**: how this project has set up the pack its view draws, read-only (see
  [The factory overview](#the-factory-overview)).

**How it works**, the pack's [factory overview](#the-factory-overview) when it has one, is a
hand-written picture of how the factory runs, for explaining it to someone who has never seen
it. It explains the pack, not the project, so it lives on the pack's page under **Factory** in
the console's sidebar, not in the project's Factory tab.

Views update within a few seconds of a run starting, changing step or ending, and of a
question opening or closing.

### The numbers

| Number | Counts |
|---|---|
| in flight | Items in a board column outside the landed stage; items set aside are not |
| items need you | Open questions and waits, and items an `awaits` outcome left waiting on a person; the Needs you tab's own count |
| merged today | Items whose change merged today, in the browser's local time |
| N of M merged | N items merged out of M in the board's columns, however long ago. Items set aside (ended, parked or idle) are not in M |
| median from first run to merged | Over merged items, the median time from an item's first run of a workflow the view names to its change merging |
| found by the factory | Findings the discoveries drains decided to file that no item carries yet; shown only when the view declares `discoveries` |

The numbers are plain figures, not links. Each counts with the same filter the board applies
for it (`?show=`), so a number and the board agree. When some items' merge state could not be
read, a line under the numbers says how many and links to the board showing only those items.
A board address that carries a filter can be shared and survives a reload; the board names the
filter on screen, with **Show all** to clear it.

### Where an item sits

Nothing stores an item's column. The console derives it from the item's runs, its open
questions and whether its change merged, taking the first rule that matches:

1. A run of a workflow the view names is running on it: the stage whose `workflows` (and
   `nodes`, when given) match the run's workflow and running step. On a step no stage names
   (a loop between rounds, or between steps) the item stays where it was on the last read,
   when that stage lists the workflow; else it goes to the workflow's first stage.
2. Its change merged: the `landed` stage.
3. Its last completed run's `workflow:outcome` is a key of `placement`, else its
   `workflow:*`: that stage. `workflow:*` also places a run that returns no outcome.
4. Its last run's outcome is a key of `endings`: off the board, in the **Set aside** list with
   its ending label as the reason ("Closed by triage", "Folded into another item"). A `parked`
   outcome is never an ending: rule 3 places it, and the item stays open.
5. Its last run failed or was cancelled: the stage whose `nodes` name the step it failed at,
   else the first stage of its workflow.
6. Otherwise the first stage.

The board, the map and the item page all place an item by these same rules.

## Where the declaration lives

For a project, the console looks for, in order:

1. The project's own file `.archon/packs/<pack key>.factory-view.json`, where the pack key is
   `owner.name` for an installed pack, else the pack's folder name. A project can present an
   installed pack it cannot edit this way.
2. `<pack>/.shared/factory-view.json` in any pack the project can run: the project's, the
   global ones, installed ones and bundled ones.

A view applies to a project when its project file exists, or when the declaration is found
and the project has at least one run of a workflow the view names. A declaration that fails to
parse or validate shows on the Factory tab with its path and the error.

## Fields

| Field | Required | What it does |
|---|---|---|
| `version` | yes | Always `1`. |
| `pack` | yes | The pack the view draws: `owner/name` when installed, else its folder name. |
| `title` | yes | The factory's name, at the top of every Factory page. |
| `summary` | yes | One paragraph in plain words: what goes in, what comes out, where people step in. Shown on the Overview. |
| `stages` | yes | The stages an item moves through, left to right: the map's cards, the stages they open, and the board's columns when `columns` is absent. Each stage has an `id` (a lowercase slug), a `label`, a one-line `blurb`, an optional `short` line for its map card (at most 24 characters, what one row of a card holding several stages shows whole; without it the card shows the blurb, cut to fit), a colour `group` (`intake`, `build`, `check` or `land`), the `workflows` whose runs count in it (empty for a stage no run works, such as Merged), and optionally `nodes`: the steps that count in it while they run. A step matches a node equal to its id, or one its id begins with followed by `.`, so `rounds` matches `rounds.fix`. A step of an included workflow is `<include>__<node>`. A stage may carry a `drilldown`: what it does step by step, as numbered `phases` (each a `label` and one to six `cards`), and an optional `loop` (`label`, `from` and `to` phase numbers, and the loop group's `workflow` and `step`) around the phases a loop group repeats. A card has a `title`, one line of `text`, an `icon` (one of `inbox`, `scale`, `link`, `ruler`, `scissors`, `database`, `clipboard-list`, `pencil`, `wrench`, `git-branch`, `search-code`, `flask-conical`, `monitor-check`, `gavel`, `message-square`, `circle-alert`, `git-pull-request`, `flag`, `send`, `shield-check` or `git-merge`), a `kind` (`agent`, `check`, `script` or `you`), and `covers`: the real steps it stands for, as `{ "workflow", "steps" }` for a workflow its stage lists. The stage's modal draws it: the phases as numbered columns of cards, the loop as one labelled frame around its phases, and a card glows while an item is on a step it covers. Clicking a card lists its real steps; "Show the real steps" draws each workflow's step graph below. A stage without a drill-down shows the graphs. |
| `columns` | no | The board's columns, left to right, each a group of stages: `{ "id", "label", "blurb", "stages": [<stage id>, ...] }`. The `blurb` is the header's one-line subtitle; name the column's stages in it. The column holding the `landed` stage always reads "last 7 days" there instead, and its `blurb` is not shown on the board. Every declared stage is in exactly one column, and the `landed` stage in a column of its own. Placement still decides an item's stage; the board puts its card in the column holding that stage, and the card names the stage. A column takes the colour of the `group` of its last stage, the one an item leaves it from; the `landed` stage's column takes the merged colour. Without `columns`, the board draws one column per stage. |
| `placement` | yes | Where an item waits after a run ends: `workflow:outcome` to a stage id, or `workflow:*` for every completed run of the workflow no exact key takes, a run that returns no outcome (a gate that only records) included. |
| `endings` | yes | Outcomes that end an item without a change: `workflow:outcome`, or `workflow:*` for every outcome `placement` does not take, to the label the Set aside list gives as the reason. Use `{}` for none. Map outcomes that mean different things to their own labels rather than with one `workflow:*`: a wildcard also ends an outcome that keeps the item open. |
| `landed` | yes | `{ "stage": <id> }`: the stage an item whose change merged sits in. |
| `rounds` | no | Where the board counts check rounds ("round 2 of 3"): one source, or a list naming each workflow once. A loop-form source `{ "workflow", "loop" }` counts the loop's iterations. A stage-form source `{ "workflow", "round", "allowance" }` counts each completed run of the workflow as one round, numbered and bounded by its result at those JSON pointers (so the bound can grow, say to 4 after an extra round is allowed); a run still going has no number yet, so the card reads "round N of M, next one running". An item's rounds come from the source whose workflow recorded a round on it most recently; with the stage form, the rounds since its numbers last started again. |
| `returns` | no | Steps whose outcome sends an item back: each `{ "workflow", "node", "outcome" }`. The board counts them as "returned ×N" and colours that round returned. |
| `approves` | no | Steps whose outcome approves a round, in the same shape. A round with neither a declared return nor a declared approval reads as needing a decision. |
| `verdicts` | no | What other steps' outcomes mean, so the item page's rounds grid words them and gives each such step a row: `{ "<workflow>": { "<step id>": { "<outcome>": "approved" } } }`, each meaning one of `approved`, `returned` or `asked`. A check's outcome then reads "Approved", "Sent back" or "Asked you". It decides nothing: only `returns` and `approves` decide a round, and an entry that restates one of theirs is rejected. An outcome no entry means reads as the pack's own token, in mono. The coverage check reports a step the workflow does not have. |
| `asked` | no | Completed outcomes that stop to ask you: `workflow:outcome`, or `workflow:*` for every outcome (not a run without one). A run that ended so reads "asked you" where the item page words a run's outcome, as does any run that left asks on the item. `placement` still decides where the item waits. |
| `parked` | no | Completed outcomes that keep an item open for later, not ended: `workflow:outcome`, or `workflow:*` for every outcome (not a run without one), each to `{ "label", "why" }`. `label` is what the item reads ("Parked by triage") in its header band and where its journey stops, with the Parked state pill; `why`, optional, is the JSON pointer to the run's reason in its result, shown after the label. `placement` must take each key, since it still decides where the item sits, and an exact `endings` key may not name one. The board sets a parked item aside while no start waits for it: it counts in no column, in flight or "N of M merged". |
| `awaits` | no | Completed outcomes after which the item is open and waits on a person, though no question is open (shaped again, say): `workflow:outcome`, or `workflow:*`, each to `{ "label", "why", "questions", "next" }`. `label` is what the item reads ("Needs shaping") on its state pill, in its header band and where its journey stops; `why`, optional, is the JSON pointer to the run's reason in its result; `questions`, optional, points at a list of what the person has to settle: the board card shows the first and how many ("4 questions"), the item page and Needs you list them. `next`, optional, is one plain sentence saying what the person does to move the item on (nothing here is answered in place); the item page and Needs you show it under "What to do". The item shows in the needs-you colour (soft, never the filled Needs you pill), counts in "items need you", and is listed on Needs you under "Waiting on you". `placement` must take each key and no exact `endings` key may name one, as with `parked`; an outcome is parked or awaits, not both. |
| `retired` | no | Workflows a stage still lists that the installed pack no longer has, so items they delivered before still place, render and count: `["deliver"]`. The coverage check neither requires the pack to have them nor compares their steps, arrows or outcomes with the pack, and fails when the pack has one again. Each must be listed by a stage, once. |
| `change` | no | Where the pull request URL is in a workflow's result: one `{ "workflow", "pointer" }`, or a list naming each workflow once. The newest run of any listed workflow with a non-empty URL at its pointer gives the item's change. |
| `partOf` | no | `{ "workflow", "pointer", "outcome" }`: the JSON pointer to the item's work order (an item key) in that workflow's result, read only from runs that completed with `outcome` (the one that accepts the item), so a refused run never makes an item a member. Read only for an item with no active `part_of` link; the newest such run decides, and an empty value there means none. |
| `discoveries` | no | `{ "workflow", "shadow", "filed", "held", "dropped", "entry": { "title", "kind", "verified" } }`: the workflow that drains what agents noticed outside their work, and where each of its completed runs' result lists what it decided, as JSON pointers: `filed`, `held` and `dropped` into the result (each a list), `entry` into each entry of `filed` (`title` required, `kind` and `verified` optional). Its runs place no item, so no stage need list it. `shadow: true` says the drains only decide what they would file: the board's panel words them "would file" and marks them shadow. It must agree with `shadows`: `true` needs a `shadows` entry naming the drain's workflow, `false` forbids one. A result recorded as text holding JSON (a script's output) is read as that JSON. A run whose result has no list at a declared pointer, or a filed entry with no title, counts as a drain that could not be read. |
| `shadows` | no | The steps the pack runs as shadows: they decide what they would do, record it, and do nothing. One entry per step: `{ "workflow", "node", "label", "reads", ... }`, with `node` the step id as the engine records it (`rounds.checks` for a loop's body step) and `label` a plain question or name ("Would it start on its own"). `reads` says how the step's value (its structured output, else its text output read as JSON) is read, each place a JSON pointer: `"verdict"` reads one string at `pointer` and words it through `words` (`{ "ask": "would ask you first" }`), with an optional `why` (a value `words` does not name shows as the pack's token, in mono); `"checks"` reads a list of checks at `results`, each entry through `entry: { "name", "passed", "seconds", "tail" }` (`seconds` and `tail` optional), and reads "4 checks · all passed · 3 min" or which failed; `"lists"` counts the lists at each `lists[]` entry's `pointer` (one to six, each with the `words` before its count: "would file 1 · would drop 2"), with an optional `why`. Each names a workflow a stage lists, or the `discoveries` workflow, and a step is declared once. Every completed run of the step is one decision, one per round in a loop; a step that was skipped, failed or not reached decided nothing. A value that does not read as declared (not JSON, cut short, a missing verdict, a check without a name or `passed`, a pointer that is not a list) reads "recorded nothing readable", never as a decision. Wherever a shadow shows, it carries a "shadow" badge and reads "would ...", never in the running, success, warning or error colours: the item page lists each decision in the panel of the stage its step is on (a round's project checks as the rounds grid's shadow row), with its why or the failed checks' output on expand; a stage modal's card covering a shadow step carries the badge and the last decisions ("last 5: would ask you first ×5"); a board card in a column whose stage lists a verdict shadow's workflow shows the item's newest decision of it; and the map marks each stage holding one with the badge, its hover and the stage's details naming each shadow step with what it decided lately ("Project checks · last 5: all passed ×5"; steps of one label, in two workflows, share one line and one tally); the map's legend says what the badge means. |
| `itemTitle` | no | `{ "input" }`: the run input whose title line is the item's title: its first non-empty line after any `---` front matter, without a leading `#<n> ` or markdown heading marker. Without it, the item's key is its title. |
| `steps` | no | Display names for steps, by workflow: `{ "<workflow>": { "<step id>": "Writes the change" } }`, keyed by the step id as the engine records it (`build__build`, `rounds.fix`, the bare loop id `rounds`). Every page prints a step by this name. A step with no name reads as its cleaned id: a doubled include name collapses (`build__build` reads "build"), an include reads `include: inner`, a loop prefix is dropped (a step of the declared `rounds` loop adds its round where it is known), and `_` and `-` become spaces. The raw id shows on hover and on the step page. A key that names no real step names nothing a page shows; the coverage check reports it. |
| `story` | no | How the item page tells what each run did, one plain sentence per stage: `{ "outcomes", "steps", "said" }`. `outcomes` maps `workflow:outcome` to a sentence, or to `{ "withChange", "withoutChange" }` when the outcome reads differently with and without a change on the item (a drop answered before any pull request), the page picking by whether the item has one ("Triage judged it worth building"), or `workflow:*` for every completed run of the workflow no exact key takes, a run that recorded no outcome included (as in `placement`); a key may name the `discoveries` workflow. `steps`, optional, words the earlier stages of a run that works several, by the step that starts each part: `{ "<workflow>": { "<step id>": "Build wrote the change" } }`. `said`, optional, lists JSON pointers into a run's result, tried in order, for what the run said in its own words: the page shows it as the reason a panel sent the item back, cut to a sentence with the rest behind "More", when a run sent the item back and no check round gave a reason (a CI send-back, say): on that panel's sentence while it is the panel's last run, else listed under the sentence with the fix that followed. It is not shown otherwise. A sentence is plain text of at most 160 characters with no placeholders; the page adds its own clauses after it (the pull request a run opened, why the checks sent it back, what you answered). With a `story`, the coverage check reports an outcome a listed workflow declares that no key takes, and a key or step the workflow does not have. Without one, the page words each run from `placement`, `endings` and `parked` ("Triage finished: sent to Plan"). |
| `answers` | no | What choosing an option of an ask starts, in plain words: `{ "<workflow>:<option id>": { "starts": "Closes the PR without merging" } }`, keyed exactly (no `*`) by a workflow a stage lists and the option id an ask its runs leave offers. The ask card shows the sentence on that option's tile, and Needs you's Answered lately and the item page show it in place of "<stage> started again" for an answer that chose it. It decides nothing: the pack's own bindings decide what an answer starts. A sentence is plain text of at most 160 characters. |
| `map` | yes | The layout of the factory map: `cards` name the stages the map draws (`{ "stage" }`; each is drawn in the card of its board column, in the column's order, and the `col` and `row` an older file has are accepted and ignored), `arrows` are every arrow it draws (`from`, `to`, an optional `label`, and `person: true` for a step a person takes, such as a replan, that no hand-off of the pack starts), and optional `notes` sit near a stage or near `needs-you`. The map draws no arrow the file does not declare, between workflows included. An arrow into an earlier card is a send-back, and so is one into its own stage or an earlier stage of its own card; one into a later stage of its own card is not drawn, since the card's rows show that order; a `back` flag an older file has is accepted and ignored. A forward arrow runs between neighbouring cards; one that would skip cards is drawn as part of the label of the hand-off from its card to the next ("fast → Merged"). Every send-back runs in one feedback lane under the row. The cards always take one row; the map pans where it does not fit. The map lists a stage's notes in its card's details; a `needs-you` note is not drawn yet. |

Every stage a field names must be declared in `stages`, and every workflow named in
`placement`, `endings`, `parked`, `awaits`, `retired`, `rounds`, `returns`, `approves`, `change` and `shadows` must be listed by
a stage; `discoveries` is the exception, and a shadow may name its workflow too.
With `columns`, every declared stage must be in exactly one column and the `landed` stage in
one of its own: a stage in no column, a stage in two, a column naming a stage `stages` does
not declare, and a column id used twice are each rejected at their path.
A drill-down card and loop must name a workflow their own stage lists.

## Example

```json
{
  "version": 1,
  "pack": "acme/release-kit",
  "title": "Release factory",
  "summary": "Issues come in as items. Plan writes down the approach, Build writes the change and opens a pull request, and a review sends it back until it approves. A person lands the change.",
  "stages": [
    {
      "id": "plan",
      "label": "Plan",
      "blurb": "Works out how to build the item.",
      "group": "intake",
      "workflows": ["plan"]
    },
    {
      "id": "build",
      "label": "Build",
      "blurb": "Writes the change and opens a pull request, then fixes what comes back.",
      "short": "Writes the change and PR",
      "group": "build",
      "workflows": ["deliver"],
      "nodes": ["build", "rounds.fix"]
    },
    {
      "id": "review",
      "label": "Review",
      "blurb": "Reads the change and sends it back when something is wrong.",
      "group": "check",
      "workflows": ["deliver"],
      "nodes": ["rounds.review"]
    },
    {
      "id": "landed",
      "label": "Merged",
      "blurb": "The change merged.",
      "group": "land",
      "workflows": []
    }
  ],
  "columns": [
    { "id": "work", "label": "Plan & build", "blurb": "Plan, build", "stages": ["plan", "build"] },
    { "id": "review", "label": "Review", "blurb": "Review", "stages": ["review"] },
    { "id": "merged", "label": "Merged", "blurb": "Merged changes", "stages": ["landed"] }
  ],
  "placement": { "plan:planned": "build", "deliver:ready": "review" },
  "endings": { "plan:declined": "Declined at planning" },
  "landed": { "stage": "landed" },
  "rounds": { "workflow": "deliver", "loop": "rounds" },
  "returns": [{ "workflow": "deliver", "node": "rounds.review", "outcome": "return" }],
  "approves": [{ "workflow": "deliver", "node": "rounds.review", "outcome": "approve" }],
  "asked": ["deliver:ask"],
  "change": { "workflow": "deliver", "pointer": "/change" },
  "discoveries": {
    "workflow": "discoveries",
    "shadow": true,
    "filed": "/filed",
    "held": "/held",
    "dropped": "/dropped",
    "entry": { "title": "/title", "kind": "/kind", "verified": "/verified" }
  },
  "shadows": [
    {
      "workflow": "deliver",
      "node": "rounds.checks",
      "label": "Project checks",
      "reads": "checks",
      "results": "/results",
      "entry": { "name": "/name", "passed": "/passed", "seconds": "/seconds", "tail": "/tail" }
    },
    {
      "workflow": "discoveries",
      "node": "result",
      "label": "What it would file",
      "reads": "lists",
      "lists": [
        { "pointer": "/filed", "words": "would file" },
        { "pointer": "/dropped", "words": "would drop" }
      ],
      "why": "/summary"
    }
  ],
  "itemTitle": { "input": "item" },
  "map": {
    "cards": [
      { "stage": "plan" },
      { "stage": "build" },
      { "stage": "review" },
      { "stage": "landed" }
    ],
    "arrows": [
      { "from": "plan", "to": "build", "label": "planned" },
      { "from": "build", "to": "review" },
      { "from": "review", "to": "build", "label": "returned" },
      { "from": "review", "to": "landed", "label": "merged" }
    ],
    "notes": [{ "text": "You answer questions here", "near": "needs-you" }]
  }
}
```

## The factory overview

A factory overview explains how a factory runs, for presenting it. It is written by hand: it
is not live, not exhaustive, and never generated from the pack's workflows. The same pack runs
on many projects, so the overview lives in the console's sidebar: **Factory** (shown once a pack
has an overview file) lists every such pack with how many projects run it, and each pack's
**How it works** page (`/console/factory/<pack key>/how-it-works`) draws its overview. With one
pack, **Factory** opens its page directly.

The pack's page is How it works only: it has no tabs and names no project. How a project has
set up the pack is that project's **Settings** page, in its Factory tab
(`/console/p/<project>/factory/settings`); an old `/console/factory/<pack key>/settings?project=<id>`
link lands there. It reads only this project and names no other. A header band counts the settings the pack
declares in its `.pack/pack.yaml`, how many the project sets in its
`.archon/packs/<pack key>.yaml`, how many fall back to the pack's default, and how many are
shadows today. Below it the settings are grouped into sections by what they govern, as the
overview's `setting_sections` and each setting's `section` say; a setting no section names is
shown under "Other settings". Each setting is a panel with its plain name, its id, one line of
the pack's description (the rest behind More), the pack's declared default when it is not
empty, and what the project sets: a path to a file, a command, or "Pack default" when the
project leaves it empty or unset. When the project's file cannot be read, one error under the
band says why, and each setting says "Not read". A
setting the overview's `settings` map marks as a policy or the checks file shows the path, says
"file not found" when the project has no such file, and lists a checks file's checks by name and
command. A shadow setting carries the shadow badge and, when the map gives one, the line saying
what changes once it is no longer a shadow. When the console could not read the project's
values at all, the page says so and shows the pack's defaults. A key
the project sets that the pack does not declare is listed under "Not declared by the pack". To
change a value, edit the project's file.

It is a root view and drill-downs. Each view lays out cards on a grid, in labelled groups,
joined by lines; a card marked ⤢ opens a closer look. A sidebar lists every view with its
number of cards and one line saying what it shows (on a phone, a menu above the map), a
breadcrumb leads back up, and **Full screen** draws the overview over the whole screen, the
legend docked in its bottom-left corner, until **Esc**. Drag to pan, scroll or use the buttons
to zoom, and **Fit** to see a whole view. A view opens at a zoom whose smallest text is at least
12 px; a view wider than the screen at that zoom opens at its start and pans.

A pack's page reads the pack's own `.shared/factory-overview.json` when it ships one. Otherwise
it reads a project's `.archon/packs/<pack key>.factory-overview.json` (the first project by
name that has one) and names that project under its title, so a project can present a pack it
cannot edit. A file that does not validate is listed with its path and the field at fault on
the pack's page; a broken pack file falls back to a project's file, its error still listed.

Lines are drawn straight, so a view validates only when its picture is clean:

- A `feeds` or `calls` line joins two ends that share a row or a column, and runs along it.
- A `loops-back` line sends work back. One from A to B in a view with a `calls` line from B to A
  is the answer to that ask: it runs beside the ask, along the same row or column.
- Every other `loops-back` line joins two cards in different columns. It drops from the bottom
  of its source into a lane under everything, runs along its own track there, and rises into its
  target, labelled where it rises. A view may have several; the root view has at least one.
  Their spans (source to target) must nest or stay apart: a line whose span holds another runs
  under it, and two lines whose spans overlap without one holding the other would cross.
- No line may run through a card other than its ends, through a group that holds neither end,
  or into another line. Move a card to give a line a clear row or column.
- Labels are not part of the check. Each label is drawn on a pill beside its line, and a pill
  wider than the room its line has can cover a card or a line: keep the label of a short line
  short, such as a send-back between neighbouring columns or an answer between neighbouring cards.

A group stacked in one column, met only along rows, whose cards no `feeds` or `calls` line
names, is drawn as parallel: a line into or out of the group branches to each card.

## Overview fields

| Field | Required | What it does |
|---|---|---|
| `version` | yes | Always `1`. |
| `pack` | yes | The pack the overview explains: `owner/name` when installed, else its folder name. |
| `title` | yes | The overview's name: its heading, and the first entry of the breadcrumb. |
| `caption` | yes | One paragraph in plain words, shown under the root view's map on the page. Full screen does not show it: whoever presents says it. |
| `root` | yes | The id of the view the page opens on. |
| `views` | yes | Every view by id (a lowercase slug). A view has `cards`, `edges`, and optionally `groups`. A drill-down view may also have its own `caption`, shown under its map as the root's is; the root view takes none, since its line is the top-level `caption`. A card has an `id` (unique across the file), a `title`, one line of `text`, an `icon`, a `kind` (`input`, `stage`, `check`, `person`, `gate` or `outcome`, which sets its colour and legend entry), its grid cell `col` and `row` (from 1), and optionally the `group` it sits in and the view it `opens`. A group has an `id` and a `label`; its box wraps its cards and may hold no other card. An edge has `from` and `to` (a card or group of the same view), a `kind` (`feeds`, `calls` or `loops-back`), an optional `label`, and optionally `shadow: true` for a line the pack would act on but does nothing about yet, which is drawn in the shadow style with "shadow" on its label. Every view but the root is opened by exactly one card. |
| `settings` | no | How a project's Settings page presents the pack's settings, by setting name: `shadow: true` for a setting whose stage runs as a shadow (it carries the shadow badge); `points_to`: `policy` for a path to a document in the project, or `checks` for the path to the project's checks file (at most one setting); `section`, the id of the `setting_sections` entry it is shown under; and, on a shadow only, `when_live`, one line (at most 160 characters) saying what changes once it stops being a shadow. Every key must be a setting the pack's `.pack/pack.yaml` declares; the Settings page lists any other as an error. |
| `setting_sections` | no | The Settings page's sections, in page order. Each has an `id` (a lowercase slug, unique), an `eyebrow` (at most 24 characters), a `title` (at most 60), a `kind` and an `icon` as a card has them, which set its colour and icon. A declared setting whose `section` is not given is shown in a trailing "Other settings" section. |

The icons are `inbox`, `issue`, `order`, `search`, `scale`, `map`, `list`, `hammer`,
`git-pull-request`, `check`, `flask`, `eye`, `sparkles`, `gavel`, `users`, `flag` and `rotate`.

## Overview example

```json
{
  "version": 1,
  "pack": "acme/factory",
  "title": "How the factory works",
  "caption": "An issue comes in. Build writes the change, Review reads it, and a change Review approves is merged. What Review finds goes back to Build, and your answer to a question restarts Build.",
  "root": "factory",
  "views": {
    "factory": {
      "cards": [
        { "id": "issue", "title": "An issue", "text": "What someone wants built", "icon": "issue", "kind": "input", "col": 1, "row": 2 },
        { "id": "build", "title": "Build", "text": "Writes the change", "icon": "hammer", "kind": "stage", "col": 2, "row": 2, "opens": "build" },
        { "id": "review", "title": "Review", "text": "Reads the change", "icon": "eye", "kind": "check", "col": 3, "row": 2 },
        { "id": "merged", "title": "Merged", "text": "The change is in main", "icon": "flag", "kind": "outcome", "col": 4, "row": 2 },
        { "id": "you", "title": "You", "text": "Answer what it asks", "icon": "users", "kind": "person", "col": 2, "row": 1 }
      ],
      "edges": [
        { "from": "issue", "to": "build", "kind": "feeds" },
        { "from": "build", "to": "review", "kind": "feeds" },
        { "from": "review", "to": "merged", "kind": "feeds" },
        { "from": "build", "to": "you", "kind": "calls", "label": "asks" },
        { "from": "you", "to": "build", "kind": "loops-back", "label": "your answer restarts it" },
        { "from": "review", "to": "build", "kind": "loops-back", "label": "sent back" }
      ]
    },
    "build": {
      "caption": "Build writes the change in its own checkout.",
      "cards": [
        { "id": "build-write", "title": "Write it", "text": "Code and tests", "icon": "hammer", "kind": "stage", "col": 1, "row": 1 },
        { "id": "build-pr", "title": "Pull request", "text": "Opened as a draft", "icon": "git-pull-request", "kind": "outcome", "col": 2, "row": 1 }
      ],
      "edges": [{ "from": "build-write", "to": "build-pr", "kind": "feeds" }]
    }
  }
}
```
