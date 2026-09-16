# Backlog

`archon-backlog` turns a product document into an ordered GitHub backlog. It works
for new and existing libraries, CLIs, desktop applications, services, and other
projects without imposing a runtime shape.

Inputs are `prd` (a path inside the checkout), `publication` (`preview` renders
`backlog.md` locally, `approve` pauses on a native approval, `auto` publishes this
run) and `max_issues` (default 12; a larger document is sliced again later).

The composition is one planner and one publisher with a deterministic check
between them. The planner (large tier) decomposes the way `plan-create-stories`
does: each implementation phase is a ticket group, each user story a ticket, every
ticket traceable to the document, small, with acceptance criteria a verifier can
check. The first ticket is the smallest runnable, testable increment appropriate to
the project and its native guidance; the pack does not invent service endpoints or
mandatory project documents. `check-backlog` refuses a slice with duplicate keys,
forward dependencies, a first ticket that depends on anything, or more tickets than
the bound. The publisher uses `gh` with a marker line per ticket
(`<!-- archon-backlog: <key> -->`), searches open and closed issues for it before
every write, and records existing issues instead of posting twice, so re-running
on the same document never duplicates the backlog.

After publication, a caller may feed issues to `archon-triage`, `archon-ship`, or
the optional `archon-lifecycle` composition. Automatic lifecycle intake requires
an explicit state-label mapping so the caller, rather than this pack, owns what
counts as previously touched.
