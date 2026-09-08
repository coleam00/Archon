# Classify Each Discovery

You are read-only. This is the one place a classification is decided; a
deterministic node after you renders it and rejects anything you produce that
contradicts the evidence already established. Nothing here writes to a
tracker: your output is a proposal for a human, never an action.

Read these two files in full before deciding anything:

- `$ARTIFACTS_DIR/discoveries/normalized.json`: the original entries
  (`item_index`, `title`, `claim`, `evidence`, `relation`, `source_nodes`).
- `$ARTIFACTS_DIR/evidence-check.json`: each entry's final `still_valid` and
  `evidence_status`, already reconciled against the current repository.

The forge search outcome is not a file: it is search-existing's declared
result, reached here as `$search-existing.output.entries`, a JSON array with
one entry per input entry, each `{ "item_index": ..., "forge_checked": ...,
"matches": [...] }`.

## Classify every entry into exactly one of

- `stale`: `still_valid` is `false` in `evidence-check.json`. The claim no
  longer holds, or its evidence could not be verified. Use whenever
  `still_valid` is false, regardless of anything found in the forge.
- `duplicate`: `still_valid` is `true` and `$search-existing.output.entries`
  names a match that is, in your judgment, the same underlying problem
  already present in the forge. Cite that exact match as `target_item`.
- `update-existing`: `still_valid` is `true` and
  `$search-existing.output.entries` names a match that is related but not
  the same problem, closely enough that the existing item should be updated
  rather than a new one opened. Cite that match as `target_item`.
- `new`: `still_valid` is `true` and no match in
  `$search-existing.output.entries` describes the same or closely related
  problem. Includes the case where no forge was reachable at all
  (`forge_checked: false`): a proposal is still a proposal, it can only not
  be published until a forge exists to publish into.

Never classify an entry `duplicate` or `update-existing` without a
`target_item` actually present in `$search-existing.output.entries` for it,
and never classify an entry `new` when `still_valid` is `false` for it.
Inconclusive evidence is not proved new work: when you cannot tell, prefer
`stale` over `new` and say why in the rationale, rather than resolve the
uncertainty in the direction of more proposed work.

## Declare the result

Your entire declared output is a JSON object with one field, `entries`: an
array with exactly one entry per input entry, in the same `item_index`
order:

- `item_index`
- `classification` (one of the four values above)
- `target_item`: `{ "number": ..., "url": ... }` for `duplicate` or
  `update-existing`, `null` otherwise
- `rationale`: one or two sentences a reviewer who has not read the other
  artifacts can act on

There is no separate sidecar file: the declared object above is the entire
record of this node's work, because the render node reads it through the
workflow's own node-output wiring, not a file this node writes.

Confirm `git status` matches what you started with, and that you created,
edited, closed, or commented on nothing in the forge.
