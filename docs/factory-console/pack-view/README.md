# The factory view for Wirasm/archon-software-factory

`factory-view.json` is the curated factory view for the pack `Wirasm/archon-software-factory` at
commit `b62ec7b20830c1675e1946d3003dcc3085ac3b0f`: the words, the Overview map, the How it works
picture, the drill-down cards and the story wording the console draws the factory with. Its shape
is `packages/workflows/src/schemas/factory-view.ts`.

A pack ships this file as `<pack>/.shared/factory-view.json`. This copy is the source: copy it into
`<installed pack>/.shared/` for the demo until the owner's own copy of the pack ships it.

Check it against a pack tree (an installed one at `plugins/packs/<owner>/<name>/<commit>`):

```
bun run check:factory-view <pack dir> --view docs/factory-console/pack-view/factory-view.json
```

A name the pack graph lacks is an error; an in-flow stage the map leaves unplaced is a warning.

The file also says where a board card finds an item's progress in its runs' records: `retired`
(workflows the pack no longer has whose runs still count, here `deliver`, with the stage an item
standing on one of their runs is placed at on the board, here `stage-build`; a bare name places
it at none, and the board sets it aside), `rounds` (the
`deliver` loop and the `stage-check` result's `/round` and `/allowance`), `returns` and
`approves` (the steps whose outcome sends an item back or approves its round) and `change`
(where a run names its pull request). Those names are checked against the graph as well; a
retired workflow's steps cannot be, since the graph lacks them.
