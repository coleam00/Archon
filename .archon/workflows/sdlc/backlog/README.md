# Backlog

`archon-backlog` turns a product document into an ordered GitHub backlog. It is how
a factory starts from nothing: the PRD is the only input.

Inputs are `prd` (a path inside the checkout), `publication` (`preview` renders
`backlog.md` locally, `approve` pauses on a native approval, `auto` publishes this
run) and `max_issues` (default 12; a larger document is sliced again later).

The composition is one planner and one publisher with a deterministic check
between them. The planner (large tier) decomposes the way `plan-create-stories`
does: each implementation phase is a ticket group, each user story a ticket, every
ticket traceable to the document, small, with acceptance criteria a verifier can
check. Two factory rules are added: the first ticket makes the product runnable end
to end (start command, health check, build-identity endpoint, tests, CI), because
nothing later can be verified until it lands; and nothing from `MISSION.md`'s
out-of-scope list is sliced in. `check-backlog` refuses a slice with duplicate keys,
forward dependencies, a first ticket that depends on anything, or more tickets than
the bound. The publisher uses `gh` with a marker line per ticket
(`<!-- archon-backlog: <key> -->`), searches open and closed issues for it before
every write, and records existing issues instead of posting twice, so re-running
on the same document never duplicates the backlog.

After publication the factory's ordinary intake takes over: `archon-lifecycle`
with an empty target selects the oldest untouched issue, which is the first ticket.
