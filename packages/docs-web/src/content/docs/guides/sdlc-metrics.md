---
title: SDLC factory metrics
description: The metrics the bundled sdlc pack records about its pull requests, issues, review rounds and tests, what each one counts and what it misses.
category: guides
area: workflows
audience: [user, operator]
status: current
sidebar:
  order: 15
---

The bundled `sdlc` pack records what its factory produced as [metrics](/guides/metrics/), for `archon metrics` and the console's Metrics page to aggregate. This page says what each metric counts. The [metrics guide](/guides/metrics/) says how records are counted, how `--compare` and `--by-model` split them, and how cost is reported.

Two workflows record them. Neither holds state; each reads its pull requests again on every run, and a re-run replaces the earlier records.

`archon-metrics-prs` records one window per run: the pull requests opened, merged or closed and the issues built or merged in the last seven days, or since `--input since=<date or Nd>`. The engine keeps the latest record per metric and subject, so the records of older pull requests and issues stand. A node's output is capped at 1 MiB, which every record of a long history exceeds. To record an install's history for the first time, run one slice at a time, about three days each on an install that built many issues a day, and use a shorter slice if a run fails on the output cap:

```bash
archon workflow run archon-metrics-prs --input since=2026-01-01 --input until=2026-01-04
```

```bash
archon workflow run archon-metrics-prs
archon workflow run archon-metrics-test-value --input since=7d
```

The pack installs no binding. The `metrics-prs` and `metrics-test-value` bindings that [`archon pack bindings sdlc`](/reference/cli/#pack-bindings) writes refresh the records on a schedule, with `overlap: skip`; the test-value binding judges the last day's merges.

## Which pull requests count

A factory pull request is one a build round opened from a `build/` branch in the repository itself. The pull requests come from the build rounds recorded on the work items. A pull request a round only continued, such as a contributor's, counts in no metric and is listed in the node's `skipped` output.

Each record names its pull request as the subject and the build-queue runs that built it as its producing runs. So it lands in the cohort of those runs, not of the day the metric ran:

```bash
archon metrics sdlc.pr_merge_rate --compare <when this checkout picked up a pack change>
```

A work item keeps its last ten build rounds. A pull request whose rounds all fell out of that record is missed, and one whose early rounds fell out is attributed to its later runs only, so it can land in a later cohort with a lower cost. These are mostly pull requests closed without merging, so the abandoned count reads low and the merge rate high.

`archon-metrics-prs` reads each pull request through the forge plugin's `pr.view`, whose `timestamps` give the creation, merge and close times. A plugin that does not report them makes the run refuse.

A merged pull request's facts never change, so a run keeps them as a state document under `pr-facts/v1/` and later runs read it in place of the forge. Both metrics workflows share these documents. An open pull request, a closed one (it can reopen) and a merged one no run has kept yet are read from the forge on every run, so a run's cost grows with those, not with every pull request recorded. The first run after a pack carrying this change reads every pull request once, as before, and writes one document per merged pull request. A document that cannot be written is noted on stderr and the run goes on.

## Pull requests

| Metric | Kind | Unit | One record per pull request, at |
|---|---|---|---|
| `sdlc.prs_opened` | count | `prs` | its creation |
| `sdlc.prs_merged` | count | `prs` | its merge |
| `sdlc.prs_abandoned` | count | `prs` | its close (1) when it closed without merging; else its merge or creation (0) |
| `sdlc.pr_merge_rate` | score | `ratio` | its merge (1) or its close without merging (0) |

A pull request still open counts as opened and has no merge rate yet. Abandoned means closed without merging, whoever closed it. Every pull request records 0 or 1 for abandoned, so a reopened pull request replaces its earlier 1; the abandoned value counts abandoned pull requests, and its `n` counts every pull request measured.

Cost per merged pull request is the cost `archon metrics sdlc.prs_opened` reports (`cost.usd` with `--json`), divided by the `sdlc.prs_merged` value over the same window. It covers the build-queue runs that built a pull request; queue runs that built none are not attributed to any. The console's Cost per PR card shows this figure. It is a floor, as [every metric cost is](/guides/metrics/#intervals-and-spend).

## Issues, by route

A pull request is the factory's product; a closed issue is its purpose. `archon-metrics-prs` also records each issue the build queue worked, read from its work item alone:

| Metric | Kind | Unit | One record per issue |
|---|---|---|---|
| `sdlc.issues_built` | count | `issues` | at its first build round |
| `sdlc.issues_merged` | count | `issues` | when the merge queue recorded its pull request merged |
| `sdlc.issue_lead_time` | score | `hours` | from intake's first record of the issue to that merge; the value is the mean |
| `sdlc.issue_build_rounds` | score | `rounds` | the build rounds a merged issue took |
| `sdlc.issue_asks` | score | `asks` | the questions a person answered on a merged issue, in the build and merge queues |

Each record names its issue as the subject and the build-queue runs that worked it as its producing runs, so `archon metrics sdlc.issues_merged --json` reports what those runs cost.

Every record is also written under its route: `sdlc.issues_merged.plan`, `sdlc.issue_asks.investigate` and so on, for `investigate`, `plan`, `deliver` and `continue`. A metric record has no field to split by, so the route is in the name. An issue's route is the one the first of its recorded build rounds that declares a route took. When none declares one, the item's intake stage stands in while it is still a route, and otherwise the issue counts only in the totals. Judge a route by its share merged, its cost and its asks:

```bash
archon metrics sdlc.issues_merged.plan --since 30d
archon metrics sdlc.issues_built.plan --since 30d
archon metrics sdlc.issue_asks.plan --compare <when this checkout picked up a pack change>
```

A work item keeps its last ten build rounds and its last twenty decisions per queue, so an issue past either undercounts its rounds or asks, and one whose first round fell out can move to its next round's route.

## Review rounds

`archon-metrics-prs` also records, for each merged factory pull request, how many review rounds it took to reach Ready, at its merge time and attributed to the build-queue runs that built it:

| Metric | Kind | Unit | One record per merged pull request |
|---|---|---|---|
| `sdlc.review_rounds` | score | `rounds` | its review rounds to Ready; the value is the mean |
| `sdlc.review_one_round` | score | `ratio` | 1 when it was Ready after one round, else 0 |
| `sdlc.review_five_plus_rounds` | score | `ratio` | 1 when it needed five rounds or more, else 0 |

A review round is one verdict a delivery round's review published on the pull request. The build queue records each run's verdicts on its build round when it records the round, and the metric reads only the work item. Every build round that carried the pull request counts, oldest verdict first. Rounds to Ready counts up to the verdict from which every later verdict is ready, so a Ready review that a later review overturned does not end the count. A pull request Ready on its first review and on every review after it took one round.

Only merged pull requests are measured: an open one can take another round, and a record cannot be withdrawn. The node's `review_rounds_distribution` output gives the number of pull requests per round count.

A round recorded when its run was released before it decided has no verdicts on the work item. For those rounds only, the metric backfills the verdicts from the run's artifacts. Run artifacts do not last: `archon workflow cleanup` and disk cleanup remove them, and the backfill cannot read a removed run.

A merged pull request is listed in `review_rounds_skipped`, with the reason, and counts in none of these when a round without verdicts has lost its run's artifacts, when its work item dropped the build rounds that may have carried it, or when it merged without a Ready review on record.

Two measures are reported in the node's `not_available` output instead of recorded, because no record carries them: the share of merged pull requests later reverted or fixed by a follow-up, and the share of blocking findings on code the change did not modify. Neither is estimated from prose.

These are scores, so they appear on the console's Details screen, not as overview cards. Compare them across a pack change, or by the model that ran the review's code lens:

```bash
archon metrics sdlc.review_rounds --compare <when this checkout picked up a pack change>
archon metrics sdlc.review_one_round --by-model ship__deliver__rounds.review__code
```

## Test and production lines

Given `lines_since`, `archon-metrics-prs` also records the lines each factory pull request merged since then added, at its merge time and attributed like the other records:

| Metric | Kind | Unit | One record per merged pull request |
|---|---|---|---|
| `sdlc.test_lines_added` | count | `lines` | lines it added in test files |
| `sdlc.production_lines_added` | count | `lines` | lines it added in every other file |

A test file is one under a `__tests__`, `test`, `tests` or `spec` directory, or named `*.test.*`, `*.spec.*`, `*_test.*`, `*_spec.*` or `test_*`. Lines are counted from the patches the forge's `pr.files` reports, one read per pull request, so the window sets the cost. A pull request with a file the forge reports without a patch, such as a binary or a very large diff, is listed in `lines_skipped` and counts in neither. The records are evidence and gate nothing. The test-to-production ratio across a pack change is the two values divided, on each side of the cut:

```bash
archon workflow run archon-metrics-prs --input lines_since=30d
archon metrics sdlc.test_lines_added --compare <when this checkout picked up a pack change>
archon metrics sdlc.production_lines_added --compare <when this checkout picked up a pack change>
```

## Test value

`archon-metrics-test-value` judges the tests in each factory pull request merged since its `since` input, one `archon-metrics-test-value-judge` run per pull request, and records per pull request:

| Metric | Kind | Unit | Meaning |
|---|---|---|---|
| `sdlc.tests_added` | count | `tests` | tests the pull request added or changed, as the judge listed them |
| `sdlc.tests_unprotective` | count | `tests` | those that protect nothing on their own merits: no plausible regression fails them that another test the judge was shown would not catch |

`since` takes an ISO date or a number of days back, such as `7d`.

Both are the judge's counts: a test the judge leaves out is in neither, and calibration scores such omissions as disagreements. Both are attributed to the build-queue runs that built the pull request, at its merge time, like the pull-request metrics. A pull request whose judge run failed has no record and is listed in the node's `skipped` output. Each pull request costs one judge run on the `large` tier, so the window sets the cost. A pull request judged again by the same judge on the same model keeps its latest record.

**What the judge reads.** The judge reads the pull request's changed files, and the text of each changed file that holds test code, at the head the file list was read at. The run refuses before any judge runs when the forge plugin lacks `pr.view`, `pr.files` or `repo.file`. A file holding test code that the forge does not return as text, such as one over 1 MB on GitHub, fails that pull request's judge run, so the pull request is listed in `skipped`. A very large test file is judged from its patch alone.

**What it judges by.** The judge applies the review's test lens, read when it runs, for its standard of what a valuable test is. The lens anchors on what a change promises; the judge's prompt overrides that anchor and adds its own rules. Redundancy is judged only against the tests the judge sees: a duplicate of an unchanged test elsewhere in the suite counts as protective. On Claude the judge runs with no tools; Codex does not enforce the restriction and can read the checkout.

### Calibrate the judge

A judged count is only as good as the judge. `archon-metrics-test-value-calibrate` runs the same judge over the pull requests your project labeled by hand in `.archon/sdlc/metrics/test-value-cases.json`, read from the checkout the run starts in, and scores it, one 0/1 record per labeled test:

- `sdlc.tests_unprotective_judge_agreement`: the verdict matches the label.
- `sdlc.tests_unprotective_judge_catch_rate`: for tests labeled unprotective only, the judge flagged it. A judge that calls every test protective scores 0 here, however high its agreement.

The file is a list with one case per pull request:

```json
[
  {
    "pr": "<pull request URL>",
    "tests": [{ "file": "<path>", "name": "<suite> > <test>", "protects": true }]
  }
]
```

`name` is the test's suite titles and own title joined by ` > `. Labels and verdicts are matched on the file and the name, ignoring case, punctuation and template placeholders such as `%s` or `${value}`, so a parameterized test written either way matches. Label by hand: labels a model drafted calibrate the judge against itself. The pack ships no labels: they are the project's own pull requests.

A labeled test the judge did not list counts as a disagreement. The node's `disagreements` output lists every test the judge got wrong, with its reason. Each record's `n` and interval say how much the labels can tell; a handful of cases gives a wide interval.

The run refuses when the file is missing or empty, when a case has no tests or two labels name the same test, when one label matches two of the judge's tests, and when the judge failed on any case, since agreement over a different set of cases is not comparable.

### One judge, one identity

All four records name the same instrument: a hash of the judge workflow's files and the criteria text it inlines. The engine adds the models that ran the judge node, so `archon metrics` reports one entry per judge and model, and never averages two.

Editing the judge's prompt, the test lens or anything in the judge's directory, including the rule that picks which files it reads in full, or remapping the `large` tier to another model, starts a new identity. Run the calibration again before trusting the counts it produces. Compare the agreement two models reached after calibrating with each:

```bash
archon metrics sdlc.tests_unprotective_judge_agreement --by-model judge
```
