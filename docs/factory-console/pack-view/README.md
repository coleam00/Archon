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
