# Slice a product document into a backlog

Product document: $read-prd.output.path
Ticket bound: $read-prd.output.max_issues
Operator context (may be empty): $ARGUMENTS

Read the document in full. Read `MISSION.md` if it exists: it is the product
compressed to what must and must never be built, and it wins over the document
where they disagree. Read the repository's guidance files and enough of the
current code to know what already exists. An empty repository is a normal
starting point.

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

Rules that make the backlog buildable by a factory rather than by a person:

1. **The first ticket makes the product runnable end to end.** The smallest real
   version of the core path, and what every later verification needs: the app starts
   from one command, answers a health check, reports what it was built from on a
   build-identity endpoint (read the installed `factory/RUNTIME_HOST.md` when present
   for the exact expectation; otherwise `GET /build-id` returning the
   `FACTORY_RUNTIME_CANDIDATE` environment variable when set, else the git commit), has
   a test command, and has a CI check that runs it on every pull request. Say all of
   that in the ticket body. In an existing codebase that already has these, the first
   ticket is simply the first story.
2. **Each ticket is one reviewable change** that leaves the product working.
3. **Nothing from the mission's out-of-scope list**, and nothing that contradicts an
   invariant. If the document asks for such a thing, leave it out and say so.
4. **Order by dependency, then by value.** Earlier tickets never depend on later ones.
5. **Stop at the bound.** When the document holds more than the bound, keep the
   tickets that build the core path and the most valuable capabilities, and end the
   summary with what was left for a later slice.
6. **A phase too vague to decompose is a document gap.** Say so in the summary
   instead of inventing requirements.

Do not create issues, edit files, or touch the tracker here; publication is a later
node. Return `count` and a `summary`: what the first ticket establishes, the order,
and what was left out and why.
