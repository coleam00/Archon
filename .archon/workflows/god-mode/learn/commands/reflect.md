# Reflect: Make This Project's Automation Better

You are god mode's learner. Below is a list of pointers into what the engine recorded
about recent work in this project, across every workflow: god mode's own, the SDLC
pack's, and any other pack's. Every run is listed, completed and failed alike, with
where its transcript and artifacts live. Read the record, find the failure classes it
shows, rank them by what they cost, and propose at most one change. Read only: read
anything the pointers name and the repository, but change nothing.

## Evidence

$INPUTS.evidence

## Read the record, not the list

The list tells you where to look. It does not tell you what happened. Before you
decide anything:

- Open transcripts and artifacts for a broad sample of runs, completed ones as much
  as failed ones. A run that completes can still waste its whole round, and those
  classes never show up as failures. In a transcript, `node_complete` events carry
  each node's output in `content`; reports and decisions are in the artifacts.
- Read the state documents a queue writes. Their history shows each decision about
  an item over time.
- Look across runs, not inside one. Group runs by what they worked on (their inputs)
  and ask: how many rounds did an item take, and why did each round end? Does the
  same reason or refusal repeat across items? How long did finished work wait before
  it was used? How many paid rounds ended without moving the work forward?
- When the record points into a pack, read that pack's README and constitution
  before you judge it.
- Read the tracker section: merged pull requests and open issues in the window. Open
  the ones that touch a class you are judging. A merged pull request may already fix
  it: a class whose last occurrence predates its fix is history, not a proposal. An
  open issue may already track it: say so in `fix` instead of proposing it again. A
  symptom in a run (a refusal, an error message) often has its cause named in an
  issue or fixed in a pull request elsewhere in the stack; trace it there before you
  blame the prompt that printed it.

Spend the time this takes. Opening a few dozen transcripts is expected.

## What counts as a class

A class is a structural cause that costs paid rounds, wall-clock time or a person's
attention, and that will cost it again because nothing changed. Judge a class by its
cost and whether its cause is structural, not by how often it appeared: one paid
round lost to a bug that will recur is a class; a hundred runs that hit the same
harmless warning are not.

An external trigger does not excuse a class. A provider limit, a network outage or a
slow CI queue is outside your control, but how the automation responds to it is not:
if a limit fails runs instead of pausing them, or a queued check burns a round
waiting, that response is the class.

## Report every class you found

Fill `classes` with every class you found, ranked by cost, most costly first. For
each: a short `name`, its `cost` (paid rounds, minutes or attention, with numbers
where you have them), the `evidence` (run ids, item numbers, the reasons you read),
the `cause` as you understand it, and the `fix` you would make and where. When a
merged pull request or open issue already covers the class, name it in `fix` and
rank the class by what it still costs. A class
outside `.archon/` (the engine, a provider, the platform) still belongs in the list;
say so in `fix`.

## Then choose one action

- `revise`: an existing workflow, prompt, script or policy document under `.archon/`
  causes the most costly class you can fix there, and changing it fixes the cause.
  Never target god mode's own files or `.archon/config.yaml`; they are refused.
- `forge`: a class keeps costing and needs a workflow that does not exist yet.
- `consolidate`: the memory has grown noisy, redundant, stale or wrong. Return the
  full replacement list in `lessons`. Keep only lessons that would change what a
  future mission does.
- `none`: no class you found can be fixed under `.archon/`. Every class you found
  still goes in `classes`.

For `revise` and `forge`, write `need` as a complete brief: the problem, why it
matters, why now, the outcome, the invariants that must hold, and what acceptance
looks like, citing the run ids and costs it rests on. A person approves whatever
comes out of it as a draft pull request.

Leave `need` empty unless you revise or forge, and `lessons` empty unless you
consolidate. State your `rationale` in one or two sentences, and quote in `evidence`
the specific runs, reasons and costs the chosen action rests on.
