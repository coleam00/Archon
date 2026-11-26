# The factory view for Wirasm/archon-software-factory

`factory-view.json` is the curated factory view for the pack `Wirasm/archon-software-factory` at
its dev branch, commit `af6d0b4a4c24a37ad60c5bc9aa56c80842248eec`: the words for its stages, steps and
outcomes, the stage items leave the map by (`merged`), the How it works picture, the
drill-down cards and the story wording the console draws the factory with. Its shape is
`packages/workflows/src/schemas/factory-view.ts`. The Overview map lays itself out from the pack
graph: the file places no card and draws no arrow. An arrow reads as its outcome's `label`, or,
for an answer to an ask, as its option's `label` in `answers` (`stage:option`): the graph and
the ask's declared options carry only the option's id.

The groups are not here: the console takes them from the pack's document, through the graph
(the manifest's `document`, else `how-it-works.md`, its `groups:` front matter, each group with
an optional `blurb` and `kind`). The pack's af6d0b4a tree has no `document` key and its document's
groups leave out `complexity`, `attend` and `catchup`, which are in flow, so `archon validate`
fails on it. Until the pack's own PR fixes that, `../pack-spike/` is an overlay for that tree: its
`archon-plugin.json` (the pack's, with `"document": "how-it-works.md"`) and `how-it-works.md` (the
pack's text under the four groups, with their blurbs and kinds). Copy both over the installed
pack's folder (`<home>/plugins/packs/Wirasm/archon-software-factory/<commit>/`) once that
folder holds the af6d0b4a tree; `fc-runtime/gate_combined.sh` (the owner's gate script, outside
this repository) does both. Keep the overlay to those two files: the gate copies the whole
folder over the pack.

A pack ships this file as `<pack>/.shared/factory-view.json`. This copy is the source: copy it into
`<installed pack>/.shared/` for the demo until the owner's own copy of the pack ships it. The pack's
dev branch tracks Archon `dev` and its main tracks the released Archon; `combined` carries Archon
`dev`, which refuses `returns.final`, so the pack's main (c1104737) no longer loads on it. The demo
installs the pack at af6d0b4a exactly, not dev's tip, which may have moved past what this file
words (`check:factory-view` against the tip says what it lacks). A demo of an older revision needs the file written for it: main
c1104737's is `git show a60acf84d:docs/factory-console/pack-view/factory-view.json`, b62ec7b's is
`git show 753d17b4f:docs/factory-console/pack-view/factory-view.json` (each graph fixture is in
the same commit).

Check it against any pack tree: an installed one at `plugins/packs/<owner>/<name>/<commit>`, or
any other folder holding `archon-plugin.json` with `--repo <owner/name>`, where `name` is the
manifest's own `name` and any owner works (its commit is the folder's own git HEAD, or reported
unknown):

```
bun run check:factory-view <pack dir> --view docs/factory-console/pack-view/factory-view.json
```

The console reads the file entry by entry and drops only what is wrong: an entry naming a stage,
step, outcome or option the graph lacks, an entry that fails its schema, or a key the schema
does not know (an older copy's `groups` among them). Every in-flow stage, step and outcome value needs words (an outcome needs
a `label`, its own or its stage's `stage:*`), as does every option an asks-settled hand-off of
an in-flow stage leaves on (its exact `stage:option` entry's `label`). Each of these is listed on the Overview and How it works and
is an error for the check, which exits 1 on any. `scripts/check-factory-view.test.ts` checks this
copy against the af6d0b4a graph in CI
(`packages/web/src/experiments/console/factory/__fixtures__/pack-graph-af6d0b4a.json`, the
check's own graph read of that tree with the overlay applied).

The file also says where a board card finds an item's progress in its runs' records: `retired`
(workflows the pack no longer has whose runs still count, here `deliver`, with the stage an item
standing on one of their runs is placed at on the board, here `stage-build`; a bare name places
it at none, and the board sets it aside), `rounds` (the
`deliver` loop and the `stage-check` result's `/round` and `/allowance`), `returns` and
`approves` (the steps whose outcome sends an item back or approves its round) and `change`
(where a run names its pull request). Those names are checked against the graph as well; a
retired workflow's steps cannot be, since the graph lacks them. One naming a workflow the graph
lacks and the file does not retire is kept and treated as retired, so a renamed stage's old runs
still count, and is listed until the file retires it.
