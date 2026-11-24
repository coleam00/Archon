# Admit policy: the factory console

The pack records this judgment today and nothing acts on it yet.

An item may start without asking the owner when all of these hold:

- It is an issue in this repository opened by the owner (coleam00) or ordered by the operator with a work order.
- It changes the factory console (`packages/web/src/experiments/console/factory`, its server routes, its docs and view files) or this repository's CI, or it takes the console's own additions elsewhere back toward Archon dev as the v2 direction asks, and nothing else.
- It does not change the database schema, the engine's workflow behaviour, or a decision written in `docs/factory-console/DESIGN.md` (its v2 direction section wins over the rest), unless the issue says it changes that decision.

Anything else is an ask: a change to the engine or the database, an issue from someone else, or one whose scope the issue does not settle.
