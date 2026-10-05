# Discover the CI that gates this merge

Record which checks are expected to gate a merge of this pull request, so the run waits for exactly those and never reads silence as a pass. You change nothing: no file, no check, no setting. No one watches this run; your declared fields are all the next nodes read.

The pull request, as the run recorded it:

$INPUTS.pr

## Find out

1. **The CI configuration**, whatever system the project uses: workflow files, a CI service's config file, a pipeline definition, contributor docs that name the required checks. Read path filters and conditions, and judge them against the files this pull request changes (the diff against its base): a job filtered away from this change will not run, so it is not expected.
2. **What the forge declares required** for the base branch, where you can read it (on GitHub: branch protection's required status checks, or the repository's rulesets). An unreadable or absent declaration is a fact to note, not an error.
3. **Exact names.** A check is expected by the name the forge reports it under, which can differ from the job's name in config (matrix jobs carry their parameters; an external CI posts its own context names). Confirm each name against the checks reported on the base branch's latest commit, or on this pull request when they have already registered. Never invent a name you cannot confirm; a wrong name makes the run wait until its bound and fail.
4. **Whether the logs are readable from here** with the tools and credentials this run has, so a failure's cause can be established later.

## Declare

- `expected_checks` — the confirmed names of the checks that must conclude green before this pull request can stay ready. Empty when nothing gates a merge on this project.
- `logs_reachable` — whether this run can read the failing jobs' logs.
- `evidence` — two to four sentences: the CI system, where its configuration lives, what the forge declares required, how you confirmed the names, and any check you left out and why.
