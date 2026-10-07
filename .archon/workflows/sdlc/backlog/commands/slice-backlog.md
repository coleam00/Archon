# Slice a product document into a backlog

Product document: $read-prd.output.path
Ticket bound: $read-prd.output.max_issues
Operator context (may be empty): $ARGUMENTS

Read the document in full, then read the repository's guidance and the project
requirements those files declare. Read enough of the current code to know what
already exists. An empty repository is a normal starting point. Do not invent a
required product document or give an undeclared document precedence over the
input.

Decompose the way a good engineering lead does. Each implementation phase in the
document is a group of tickets; each user story becomes one ticket, or more when it
hides more than about a day of work. A ticket that cannot be described on one screen
is two tickets. Every ticket traces back to a phase or a story in the document.

Write `$ARTIFACTS_DIR/backlog.json`: a JSON array of tickets, in the order they should
be built. Each ticket is an object with:

- `key`: a short stable slug, lowercase, unique within this backlog.
- `title`: imperative and specific, the outcome as a person would say it.
- `phase`: the document's phase or story this ticket comes from, verbatim.
- `body`: Markdown that passes the pack's contract test on its own, so triage routes
  it READY without guessing: the problem, why it is worth solving, the desired outcome,
  the invariants that must hold, and acceptance criteria as a checklist a verifier can
  check with exact values, not adjectives. Name the document section it comes from.
- `depends_on`: keys of earlier tickets this one needs; usually empty or one.
- `size`: `small_bounded`, `risky`, or `large`.

Rules that make the backlog buildable in dependency order:

1. **The first ticket is the smallest runnable, testable product increment.** It
   establishes the core path appropriate to this project: a library can expose and
   test its first useful API, a CLI can execute one real command, a desktop app can
   open one working flow, and a service can serve one useful request. Use the
   project's declared build, test, CI, runtime, and evidence requirements. Do not
   invent a server, port, health endpoint, build identity, persistence layer, or CI
   system when the product and project guidance do not require one. In an existing
   codebase, the first ticket is the first unmet story that leaves declared checks
   passing.
2. **Each ticket is one reviewable change** that leaves the product working.
3. **Honor declared scope and invariants.** If the document conflicts with current
   project guidance, leave the conflicting work out and say so.
4. **Order by dependency, then by value.** Earlier tickets never depend on later ones.
5. **Stop at the bound.** When the document holds more than the bound, keep the
   tickets that build the core path and the most valuable capabilities, and end the
   summary with what was left for a later slice.
6. **A phase too vague to decompose is a document gap.** Say so in the summary
   instead of inventing requirements.
7. **Nothing new is a valid slice.** When every ticket the document yields is
   already in the tracker (an open or closed issue carrying it, or code that
   already does it), write an empty array, return `count` 0, and say in the
   summary what already covers the document. That is a fact about the backlog,
   not a failure, and nothing is published.

Do not create issues, edit files, or touch the tracker here; publication is a later
node. Return `count` and a `summary`: what the first ticket establishes, the order,
and what was left out and why.
