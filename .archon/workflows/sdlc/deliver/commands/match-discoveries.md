# Match discoveries to open issues

This run proved work outside its change and is about to file each discovery as an issue. Before it does, find the ones an open issue already describes, so the same defect is not filed twice. This is a small, best-effort search: a miss files a duplicate, and nothing waits on you. You change nothing and write nothing to the tracker.

The pull request, whose repository holds the issues:

$INPUTS.pr

The discoveries. When the second list is not `null`, it is the final one and the one to match; otherwise match the first:

$INPUTS.initial

$INPUTS.final

## Match

For each discovery, search the repository's open issues for the same defect — the same broken behavior or missing guard at the same place — using a few searches on its distinctive terms (the file, the function, the symptom). A different wording of the same defect is a match; a different defect in the same file is not. Judge by the claim and the evidence, not the title. When a search fails, move on: declare no match for that discovery.

## Declare

- `matches` — one entry per discovery that an open issue already describes: `index`, its zero-based position in the list you matched, and `issue`, the matching issue's number in this repository. Leave out every discovery with no match. Empty when there are no discoveries or no matches.
