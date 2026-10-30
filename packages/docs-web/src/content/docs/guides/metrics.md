---
title: Metrics
description: Track counts and judged scores across workflow runs with archon metrics.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 13
---

A metric is an ordinary node output. Any node that returns a top-level `metrics` array
of records stores them with its completion, and `archon metrics` and `GET /api/metrics`
aggregate those records across runs by name, time window and subject. There is no
metric node type and no metric config file: a script node counts, a prompt node judges.

## A count metric from a script node

This workflow records one `repo.commits` record per commit of the last 30 days. Each
record names the commit as its `subject` and its commit time as `at`, so running the
workflow again replaces the same records instead of counting them twice.

```yaml
name: count-commits
description: Record each recent commit as a repo.commits metric
nodes:
  - id: count
    runtime: bun
    script: |
      const log = Bun.spawnSync(['git', 'log', '--since=30 days ago', '--format=%H %cI']);
      if (log.exitCode !== 0) throw new Error(log.stderr.toString());
      const metrics = log.stdout.toString().trim().split('\n').filter(Boolean).map(line => {
        const [sha, at] = line.split(' ');
        return { name: 'repo.commits', kind: 'count', unit: 'commits', value: 1, subject: sha, at };
      });
      console.log(JSON.stringify({ metrics }));
    output_format:
      type: object
      required: [metrics]
      properties:
        metrics: { type: array }
```

```bash
archon workflow run count-commits
archon metrics repo.commits --since 7d
```

## A judge metric from a prompt node

A prompt node can return records itself. An SDK-enforced provider fails a node whose
output misses its schema without asking again, so give the node the complete record
schema below as its `output_format`. JSON is valid YAML, so the block can be pasted
under `output_format:` as it is.

```yaml
nodes:
  - id: judge
    prompt: |
      Read README.md and judge how clearly it tells a new user how to install and run
      the project, from 0 (not at all) to 1 (completely). Return one metric record:
      name docs.readme_clarity, kind score, unit ratio, subject README.md,
      instrument readme-judge-v1 and instrument_node judge.
    allowed_tools: [Read]
    output_format: # paste the record schema from the next section here
```

Codex structured output requires every declared property to be required, so it refuses
this schema's optional fields. On Codex, have the prompt node return its own verdict
shape and map the verdict to records in a script node that follows it.

## The record schema

Every `metrics` key is checked against the engine's record schema when the node
completes, whatever the node's own `output_format` says. A malformed record fails the
node as an output-contract failure. A node output without a `metrics` key is not
affected; to use the key for something else, rename it.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "metrics": {
      "type": "array",
      "items": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 128,
                "pattern": "^[a-z0-9_]+(\\.[a-z0-9_]+)*$"
              },
              "unit": {
                "type": "string",
                "pattern": "^[a-z0-9_%/.-]{1,32}$"
              },
              "subject": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 256
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "at": {
                "type": "string",
                "format": "date-time"
              },
              "runs": {
                "minItems": 1,
                "maxItems": 20,
                "type": "array",
                "items": {
                  "type": "string",
                  "pattern": "^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$"
                }
              },
              "instrument": {
                "type": "string",
                "pattern": "^[A-Za-z0-9_.:@/-]{1,128}$"
              },
              "instrument_node": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255
              },
              "kind": {
                "type": "string",
                "const": "count"
              },
              "value": {
                "type": "number",
                "minimum": 0
              }
            },
            "required": [
              "name",
              "unit",
              "subject",
              "kind",
              "value"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 128,
                "pattern": "^[a-z0-9_]+(\\.[a-z0-9_]+)*$"
              },
              "unit": {
                "type": "string",
                "pattern": "^[a-z0-9_%/.-]{1,32}$"
              },
              "subject": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 256
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "at": {
                "type": "string",
                "format": "date-time"
              },
              "runs": {
                "minItems": 1,
                "maxItems": 20,
                "type": "array",
                "items": {
                  "type": "string",
                  "pattern": "^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$"
                }
              },
              "instrument": {
                "type": "string",
                "pattern": "^[A-Za-z0-9_.:@/-]{1,128}$"
              },
              "instrument_node": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255
              },
              "kind": {
                "type": "string",
                "const": "score"
              },
              "value": {
                "type": "number"
              },
              "calibrates": {
                "type": "string",
                "maxLength": 128,
                "pattern": "^[a-z0-9_]+(\\.[a-z0-9_]+)*$"
              }
            },
            "required": [
              "name",
              "unit",
              "subject",
              "kind",
              "value"
            ],
            "additionalProperties": false
          }
        ]
      }
    }
  },
  "required": [
    "metrics"
  ],
  "additionalProperties": false
}
```

- `name`: dot-separated lowercase segments, such as `factory.prs_merged`.
- `kind`: `count` sums its values; `score` takes their mean. A score whose values are all
  0 or 1 is a rate.
- `unit`: what the value counts or measures, such as `prs` or `ratio`.
- `subject`: what the record is about, such as a pull request URL, or `null`.
- `at`: when the outcome happened. Without it, the node's completion time is used.
- `instrument`: what measured the value, such as a hash of a judge's prompt.
- `calibrates`: on a `score`, the metric this score calibrates.
- `runs`: the runs that produced the outcome, 1 to 20 run ids. A record without `runs` was
  produced by the run that returned it. Name the runs that did the work, not the metric
  run that observed it: a merged pull request belongs to the runs that built it. Don't
  list both a run and its child run, since a parent's cost already includes its children.
- `instrument_node`: the node that did the measuring. It is stored and validated, but
  `archon metrics` does not read it yet.

Records hold only these fields. A record with any other key is refused, so a record
cannot carry credentials, prompt contents or messages beyond its bounded `subject` and
`instrument`.

## How records are counted

- **A name has one meaning.** The first stored record of a name fixes its `kind`, `unit`
  and `calibrates`. A later record that disagrees is left out of every aggregate and
  reported as refused, with both definitions. To fix a wrong first definition, rename the
  metric, or delete the run that wrote it.
- **The latest record per subject wins.** For a non-null `subject`, the latest stored
  record of a name, subject and instrument replaces the earlier ones, so re-measuring a
  subject never counts it twice. A `subject: null` record counts once for each run of
  the node that returned it.
- **Only a node's final result counts.** When a node runs again in the same run, or its
  completion is later marked failed, only its last result counts, and a failed one
  counts nothing. A `workflow:` node, a `loop_group` or a fan-out include that passes on
  another node's output does not count its records again.
- **Windows use `at`.** A record falls in a window by `at`, or by its completion time when
  it has none. The window includes its start and excludes its end.
- **Instruments are kept apart.** A name reports one entry per `instrument`, so a new
  judge version never averages with the old one. The headline is the instrument of the
  newest record.
- **Records live with their runs.** Deleting a run, for example with
  `archon workflow cleanup`, deletes its records.

## Intervals and spend

Every entry reports `n`, the records it counts after the rules above. A `score` with at
least two records also reports a 95% `interval`: the Wilson score interval when every value
is 0 or 1, so the score is a rate, and otherwise the mean ± t(0.975, n−1) · s / √n. A
`count` has no interval.

Each entry also reports the `cost` of its producing runs: `usd`, `input_tokens` and
`output_tokens` summed over the distinct runs its records name, each run once. Providers
that report no cost, such as Codex, add tokens but no cost, so the sum is a floor, never a
total. `runs_without_cost`, `runs_without_tokens` and `runs_missing` count the runs that
added nothing to it: runs that recorded no cost, no tokens, or no longer exist. `usd` is
`null`, not `0`, when no run recorded a cost. Tokens of differently priced models do not compare as
spend.

## Comparing before and after a change

`archon metrics <name> --compare <cut>` (or `compare=` on the API) splits each entry's
records by when their producing runs started. A record whose runs all started before the
cut is in `before`; one whose runs all started at or after it is in `after`. The record's
`at` does not decide it: a pull request merged after a change, but built by runs that
started before it, belongs to `before`.

```bash
archon metrics sdlc.pr_merge_rate --since 60d --compare 2026-10-15T09:30:00Z
```

- **Straddling.** A record with runs on both sides of the cut, such as a pull request
  built before the change and fixed after it, is in neither cohort. `straddling` counts it.
- **Unattributed.** A record whose named runs no longer exist is in neither cohort.
  `unattributed` counts it. It is never credited to the run that returned it, which ran
  after the cut. It still counts in the entry's `value`.
- **The difference.** `delta` is `after − before`, with its own 95% `delta_interval`:
  Newcombe's hybrid score interval for a rate, Welch's interval for other scores. Each
  cohort needs at least two records. `separated` is true when that interval excludes zero.
  Don't judge by whether the two cohort intervals overlap: that is far stricter than a
  test of the difference, and two rates can differ while their intervals overlap.
- **Pick the cut by when the install ran the change.** The cut is when the install's
  checkout picked the change up, not when the change merged.
- **The after cohort is younger.** It has had less time for slow outcomes, such as a pull
  request being merged, to resolve. Read a comparison after the after cohort has settled.

A comparison is observational. The cohorts differ in the change and in everything else
that changed around the cut, and in the work each cohort happened to run: the SDLC pack,
for example, routes larger work to Claude and small work to Codex. The text output of
`archon metrics --compare` ends with a line that says so. Showing that a change caused a difference needs runs
assigned to each side independently of the work.

Metric names are shared by every project on the install. Pass `--project` to read one
codebase's records; their names keep the install's definitions.

## Reading metrics

```bash
archon metrics                                   # every metric of the last 30 days
archon metrics docs.readme_clarity --since 2w    # one metric
archon metrics repo.commits --since 2026-10-01 --until 2026-10-08 --json
archon metrics --project acme/widgets
curl 'http://localhost:3090/api/metrics?name=repo.commits&since=7d'
```

Each metric reports its `value` (the sum or the mean), `n` (the records counted), its
`interval`, the `cost` of its producing runs, its latest record and a daily `series`, per
instrument, and a `compare` block when a cut is given. `archon metrics` exits `4` when it
refused a record, and prints each refusal to stderr. See
[`archon metrics`](/reference/cli/#metrics-name) and
[`GET /api/metrics`](/reference/api/#metrics) for every option.
