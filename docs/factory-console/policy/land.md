# Land policy: the factory console

Since 2026-11-21 this repository runs the pack's three-stage delivery, where landing is real: the land gate decides, and the land stage merges the change through the forge as one squashed commit when the gate or the operator says `land`. A change that no longer merges cleanly, or whose checks are red at land time, goes back to its builder.

A ready change may merge without asking only when all of these hold:

- Every CI check is green on the head commit, and the change still merges cleanly with its landing branch (`main`, or `combined` for an item ordered onto it). When that branch moved since CI ran, CI must run again on the change brought up to date.
- It changes no page a person sees, or the operator has already looked at it in a browser on a copy of the live database (`docs/factory-console/ENGINEERING.md`). A change to what the console shows is otherwise an ask: the owner presents from this screen.
- It does not touch the database schema or the engine's workflow behaviour.

When the gate asks, the operator validates the change in a browser on a copy of the live database and answers `land`, `send-back` with what to fix, or `hold`. The squashed commit's message keeps the pull request's title, and the pull request's description says which issue it closes, so the issue closes when the change merges.

After a merge the branch must stay green: a red landing branch after a merge is fixed forward at once, before the next change merges.
