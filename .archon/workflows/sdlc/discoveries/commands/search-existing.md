# Search The Forge For Existing Work

You are read-only. You may search the configured forge; you may never
create, edit, close, comment on, or label anything in it. This node only
finds out what already exists.

Read `$ARTIFACTS_DIR/discoveries/normalized.json` and
`$ARTIFACTS_DIR/evidence-check.json` in full first. Only entries whose
`item_index` has `still_valid: true` in `evidence-check.json` need a search;
an entry already marked not valid there stays out of scope for this node, and
you do not need to search for it.

## Whether a forge is reachable

A deterministic node already checked this, once, so you do not need to probe
it yourself: `forge_available` is `$resolve-input.output.forge_available`,
`forge_host` is `$resolve-input.output.forge_host`, and `forge_path` is
`$resolve-input.output.forge_path`.

- If `forge_available` is `false`: do not attempt any forge read. Record
  every in-scope entry as `forge_checked: false` with no matches, and move
  on. This is a normal outcome, not a failure: it means later classification
  can only ever propose local, unpublished action, never a duplicate or an
  update against an existing item.
- If `forge_available` is `true`: for each in-scope entry, use the
  repository's forge CLI (`gh`, scoped to `forge_host`/`forge_path`) to
  search open and recently closed tracker items for the same problem: try
  the entry's own title first, then its most distinctive claim language.
  Judge duplication by what the item is actually about, not by matching
  words: a title that shares vocabulary but describes a different defect is
  not a match.

## For every in-scope entry

Record, per entry:

- `forge_checked` (boolean: did you actually search for this one)
- `matches`: an array of `{ "number": <issue/PR number>, "url": ...,
  "title": ..., "similarity_note": "<why you judge it the same or related
  work>" }`, empty when nothing plausible turned up. Only include an item you
  are prepared to defend as the same underlying problem or a closely related
  one; when unsure whether two items describe the same thing, leave it out
  rather than guess.

## Declare the result

Your entire declared output is a JSON object with one field, `entries`: an
array with exactly one entry per entry in `normalized.json` (including
out-of-scope ones, so the array stays aligned with the other nodes'), in the
same `item_index` order: `{ "item_index": ..., "forge_checked": ...,
"matches": [...] }`. An out-of-scope entry gets `forge_checked: false` and an
empty `matches` array. There is no separate sidecar file: the declared
object above is the entire record of this node's work, because the render
node reads it through the workflow's own node-output wiring, not a file this
node writes.

Confirm `git status` matches what you started with, and that you created no
tracker item, comment, or label anywhere.
