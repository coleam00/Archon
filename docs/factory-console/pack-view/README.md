# The view file for Wirasm/archon-software-factory

`factory-view.json` is the view file for the pack `Wirasm/archon-software-factory` at its dev
branch, commit `af6d0b4a4c24a37ad60c5bc9aa56c80842248eec`. It holds the How it works explainer
only: a one-paragraph `summary` and the hand-laid How it works picture. Its shape is
`packages/workflows/src/schemas/factory-view.ts`. A pack ships it as
`<pack>/.shared/factory-view.json`; this copy is the source until the owner's copy of the pack
ships it.

Everything else the console shows about the pack comes from the pack graph, which serves the
pack's own YAML (DESIGN.md, COMBINED direction, "No hand-synced view file"):

- **Words**: each workflow's `display:` block gives its stage label, short line, blurb and
  story, its outcomes' labels and stories, its ask options' labels (`answers`) and the stage
  modal's drill-down cards (`phases`); each node's `display.label` names its step, an included
  node's under the id its runs record (`review__review`).
- **Meaning**: `display.marks` (`means: returns` sends an item back, `means: approves` approves
  its round), `display.results` (where a run's result holds its `round`, `allowance` and
  `change`) and `display.replaces` (a retired workflow, here `deliver` on `stage-build`, with its
  own `loops`, `marks` and `results`, so its old runs count and stand at that stage).
- **Pack words and the exit stage**: the document's front matter, `words` (`round`, `rounds`,
  `sentBack`, `parked`, `workOrder`, `workOrders`) and `exit` (the stage items leave the map by,
  here `landed`), beside `groups`.

The pack's af6d0b4a tree carries none of that yet. `../pack-spike/` is an overlay for that tree,
with only the files it changes at pack-relative paths: every workflow file that gains a
`display:` block (the stages and the workflows they include), `archon-plugin.json` (with
`"document": "how-it-works.md"`) and `how-it-works.md` (the groups, their blurbs and kinds, the
words and the exit). The owner's orchestrator turns it into the pack's PR. To run the console
on it, replace the installed pack folder
(`<home>/plugins/packs/Wirasm/archon-software-factory/<commit>/`) with the af6d0b4a tree, copy
the overlay over it, and copy this file into its `.shared/`; `fc-runtime/gate_combined.sh` (the
owner's gate script, outside this repository) does all three. The overlay's words are today's
console words; `archon validate` on the overlaid tree reports no stage, step, outcome or option
without words.

Check this file against any pack tree: an installed one at `plugins/packs/<owner>/<name>/<commit>`,
or any other folder holding `archon-plugin.json` with `--repo <owner/name>`, where `name` is the
manifest's own `name` and any owner works:

```
bun run check:factory-view <pack dir> --view docs/factory-console/pack-view/factory-view.json
```

The console reads the file and drops only what is wrong: a key the file does not have (an older
copy's `stages`, `outcomes` or `rounds` among them), or a stage or edge the How it works picture
names that the graph lacks. Each is listed on the Overview and How it works and is an error for
the check, which exits 1 on any. `scripts/check-factory-view.test.ts` checks this copy against
the af6d0b4a graph in CI
(`packages/web/src/experiments/console/factory/__fixtures__/pack-graph-af6d0b4a.json`, the
check's own graph read of that tree with the overlay applied).
