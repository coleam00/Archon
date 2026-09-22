# Prepare the final pull request body

Bring the recorded pull request description in line with the final diff after correction
rounds. The exact target is:

$INPUTS.pr

Read that qualified PR through forge `pr.view` and inspect its full diff with an adaptable
read tool. Do not modify repository files, commit, push, change draft state, or publish.
Check each concrete body claim against the final diff. Preserve accurate text and structure;
change only falsified claims. Add any missing red-gate disclosure from the run's typed
green-gate artifacts.

If no change is needed, write `$ARTIFACTS_DIR/pr-body-intent.json` as `{"change":false}`.
Otherwise write the intended complete body to `$ARTIFACTS_DIR/pr-body-final.md` and the intent
as `{"change":true,"bodyPath":"$ARTIFACTS_DIR/pr-body-final.md"}`. Return only
`{"intent":"$ARTIFACTS_DIR/pr-body-intent.json"}`. The following deterministic node owns
the edit and read-back verification.
