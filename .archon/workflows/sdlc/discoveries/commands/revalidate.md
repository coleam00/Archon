# Revalidate Discoveries Against Current Source

You are read-only. Nothing you do here may change the working tree, and
nothing here writes to a tracker. Your only job is to judge, per discovery,
whether the claim still holds against the repository as it exists right now.

Read `$ARTIFACTS_DIR/discoveries/normalized.json` in full before judging
anything. It is a JSON array; each entry has `item_index`, `title`, `claim`,
`evidence` (a list of prose evidence strings, possibly citing files, lines,
commands, or output), `relation`, and `source_nodes` naming which prior run
node raised it.

## For every entry

Treat the claim as a hypothesis to check, not a fact to relay. For each
entry:

1. Read the files the evidence names, at the repository's current state
   (`HEAD`), not at whatever revision the discovery was originally raised
   against.
2. Decide whether the claim still holds: does the behavior, gap, or defect
   the claim describes still exist in the current code, or has it since been
   fixed, refactored away, or superseded by later work?
3. Extract the concrete evidence you actually grounded that decision in as
   structured citations: one or more `{ "path": "<repo-relative path>", "line":
   <1-based line number> }` pairs. Only cite a location you actually opened
   and read. If the entry's prose evidence does not resolve to any citable
   file and line you could verify, say so; do not invent a plausible-looking
   citation to fill the field.
4. Write one short note explaining the verdict: what changed, or what you
   confirmed still applies.

An entry whose evidence you cannot resolve to a real, current location is not
proved and must not be marked still valid, even if the claim sounds
plausible. A deterministic node downstream verifies every citation you write
against the actual current repository and will override a claim that outruns
its own evidence, so cite only what you actually checked.

## Declare the result

Your entire declared output is a JSON object with one field, `entries`: an
array with exactly one entry per input entry, in the same `item_index`
order, each with:

- `item_index` (matching the input entry)
- `still_valid` (boolean)
- `evidence_refs` (array of `{ "path": ..., "line": ... }`, may be empty)
- `note` (a short sentence)

Do not add, drop, or reorder entries. An input you cannot resolve at all
still gets an output entry: `still_valid: false` and a note explaining why.
There is no separate sidecar file: the declared object above is the entire
record of this node's work, because a downstream deterministic node reads it
through the workflow's own node-output wiring, not a file this node writes.

Before declaring, confirm `git status` matches what you started with: you
read files, you did not change any.
