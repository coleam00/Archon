# Verify the Blocking Findings

Decide, for each blocking finding the review kept, whether it is real and belongs to this change. You are one of three independent verifiers; the others do not see your answer, and a finding stays blocking unless at least two of you reject it.

Read `$ARTIFACTS_DIR/review/scope.md` for the change, its diff and its accepted contract, then `$ARTIFACTS_DIR/review/findings.json` and the findings in `$ARTIFACTS_DIR/review/report.md`. Judge every record in findings.json whose `severity` is `blocking` and whose `status` is `open`. Skip a record whose `sources` include `contract`: contract coverage stays blocking whatever you answer.

- **real**: the defect exists at the reviewed head as the finding states it. Check the cited code yourself; a finding whose path you cannot reach, whose claim the code contradicts, or that only guards against a failure no supported path reaches today is not real.
- **belongs**: the change introduced it, made it reachable, or made a claim false; or an acceptance or invariant item in scope.md names the behavior. A defect in code the diff does not modify that behaves the same at the base, and that no contract item names, is pre-existing: it does not belong. Check the base (`git show <merge-base>:<path>`) before deciding that.
- A finding is a real defect when it is one of the kinds the review blocks on as the report states it: a wrong outcome, an untrue comment or doc, undocumented user-facing behavior, an unproved guard or acceptance item, a useful test gap (the behavior matters, a plausible edit to the code as it stands breaks it while every current test stays green, and the test it asks for is one worth keeping), or, when the smaller shape is proved to keep behavior, unneeded or doubly owned structure the change adds. Style, wording, naming and diagnostics with none of those costs are not real defects.

Read-only: never modify this checkout, commit, or write outside `$ARTIFACTS_DIR`. Read code and run read-only commands; do not install dependencies or run test suites.

Write `$ARTIFACTS_DIR/review/verify-$INPUTS.voter.json`: a JSON array with one record per judged finding, `{"id": "R1", "real": true, "belongs": true, "reason": "one sentence with file:line"}`. Write `[]` when there is no open blocking finding to judge. Reply with one line naming the file and how many you upheld.
