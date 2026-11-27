# Discoveries policy: the factory console

What agents notice outside the change they were building.

File as a new issue in this repository:

- A bug a person would meet in the console (wrong count, broken link, stale view, layout that breaks at 1440 px or 390 px).
- A gap in CI or validation that let, or could let, a broken change through.
- A place where the factory section shows an engine id, a raw option id, or the word "landed" to a person. Archon's own ask card and other Console pages are drawn as on Archon dev and are not findings here.

Do not file:

- Style preferences, renames or refactors with no effect a person sees.
- Faults in the Archon engine or in the factory pack itself: those go to their own maintainers, so write them down in the run's notes and the operator passes them on.
- Anything an open issue in this repository already covers.
- Anything that asks to restore or extend what the v2 direction in `docs/factory-console/DESIGN.md` removed: step pages, the Settings page or pack settings, the pack index page, shadow steps or badges, parsing of agent prose, structure written in a side file instead of read from the pack graph, or changes to Archon's own Console outside `factory/`.
