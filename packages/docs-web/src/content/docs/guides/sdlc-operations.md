---
title: Operate the SDLC factory
description: How to install the bundled sdlc pack's bindings, start work with a label, follow an item, answer what it asks, and recover a stage that did not start.
category: guides
area: workflows
audience: [user, operator]
status: current
sidebar:
  order: 14
---

This page is the operator manual for the bundled `sdlc` pack. Set the pack up first, with the [setup guide in the pack's README](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md#set-it-up). [The SDLC factory](/getting-started/sdlc-factory/) says what the factory is and what it writes. [SDLC pack workflows](/reference/sdlc-workflows/) lists every stage, what starts it and how it ends.

The pack keeps no record of its own. What happened to an issue is its item, `issue-<n>`: the runs on it, the outcome each ended with, the questions it left and their answers. Everything below reads and acts on that.

## Install the bindings

The pack declares its hand-offs in `.pack/pack.yaml`. A declaration starts nothing; write the files for one repository:

```bash
archon trigger whoami                       # the run-as user id
archon pack bindings sdlc --repo github.com/<owner>/<name> --host <host-id> \
  --run-as <user-id> --out ./sdlc-bindings
```

It refuses the whole set, writing nothing, when a binding names an outcome, option or input a stage does not declare. It prints what to do with each file:

- **Run-ended and asks-settled files** go into the triggers directory with `archon trigger add <file>`, one at a time. Each is active at once.
- **The label binding** is an object for the GitHub source plugin: add it to `bindings` in the source's `config`, in the file `ARCHON_WEBHOOK_SOURCES` names.

Then check them:

```bash
archon trigger check
archon pack graph sdlc
```

`trigger check` reports a file that names a missing stage or an input a stage does not declare. A run on an item is refused before it starts while a binding its end could fire is broken, so fix a reported problem before starting work. `pack graph` lists each stage's outcomes and the arrows between them; an arrow whose file is not installed shows as inactive.

To change a binding after a pack update, write the files again with `--force` and add each one again.

Each binding holds a resource named `sdlc-<stage>`, such as `sdlc-build` (five runs at once) or `sdlc-land` (one, so changes land one at a time). Set another number with `concurrency.resources` in `~/.archon/config.yaml`, keyed by the full resource name the generated binding file holds.

## Start work with a label

Adding the label `archon-triage` to an issue starts triage on its item. Only an account with triage rights on the repository can add a label, so an issue nobody labelled reaches no agent. Opening or editing an issue starts nothing.

An install that receives webhooks gets the label event from GitHub. One that receives none, such as a laptop, reads labels by observing: give the source `"observe": { "everySeconds": 60 }` and keep a watcher running with `archon workflow wake schedule install`. A label that was already on an issue when the binding was first seen starts nothing; remove it and add it again. See [label an issue without a webhook](/guides/workflow-triggers/#label-an-issue-or-pull-request-without-a-webhook) for what a pass reads and costs.

The same label restarts triage later: when triage asked the author questions, remove the label and add it again once they answered.

You can also start any stage by hand on an item, for example `archon workflow run archon-triage --item issue-42 --input issue=42`.

## Follow an item

```bash
archon workflow runs --item issue-42          # runs, outcomes, open questions, answers, waiting starts
archon workflow runs --item issue-42 --json   # the same, with each run's cause and the round limits
```

Each run shows the outcome it ended with and, for a stage a binding started, the run whose end caused it. A start that waits for a free slot or behind another run of the same stage on the item is listed with what it waits for; a start the engine refused is listed with why.

To see progress on the issue itself, turn on the item tracker (`itemTracker` in `~/.archon/config.yaml`, see [show progress on the item's tracker](/guides/workflow-triggers/#show-progress-on-the-items-tracker)). The engine keeps one status comment on the issue, posts each question with the command that answers it, and posts the result when the item stops.

## When an item stops

A stage that ends with an outcome nothing starts from, and leaves no ask, stops its item unless the outcome is one its workflow declares final (a closed issue, an item that waits, a review by hand). `archon workflow attention` lists a stopped item as `stopped`, with the stage's one-line summary. Triage's `not_triaged` (a forge read failed) and investigate's `inconclusive` stop on purpose: start the next stage by hand, or start the stage again.

## Answer what a stage asks

A stage that needs a decision ends and leaves its questions as asks on the item. List and answer them:

```bash
archon workflow attention
archon workflow answer --ref ask:<id> --choose <option>
archon workflow answer --ref ask:<id> --recommended
archon workflow answer --withdraw ask:<id>
```

When every ask a run left is answered, the answer starts the next stage. Most stages start themselves again with your answer as a decision made: triage, link, investigate, split, plan, build and discoveries. Link offers `wait` (keep waiting on what it depends on), `start-anyway` (stop waiting and build it now), `drop` (the item ends), and for two overlapping items `keep-this` and `keep-other`. Review, host and land offer fixed options, and the option you choose decides what starts:

| Asked by | Option | Starts |
|---|---|---|
| review, host | `send-back` | the builder, with your answer and the report |
| review | `take-as-is` | the host stage, on the change as it is |
| host | `take-as-is` | the land stage |
| review, host | `replan` | planning |
| land | `land` | the land stage again, approving the pull request at the head the question named |
| land | `send-back` | the builder |
| review, host, land | `stop` | nothing; land or close the change by hand |

An answer that starts nothing says so: `archon workflow answer` ends with "No trigger binding starts on this settlement, so nothing was started." Every later stage on the item reads every answer given on it, oldest first.

## Items that wait

Triage's `plan` and `build` go through the link stage first, which decides whether the issue can be built now. When it depends on other work still on its way, link records a `depends_on` link to it and ends `waiting`. When that item lands, or ends without landing (triage `close` or `split`, investigate `refuted`), link starts again on every item that depends on it, and places it or asks. `archon workflow runs --item issue-42` lists the item's links.

## Round limits

A change goes back to its builder at most three times per way back (from review, from host, from land) until the item is planned again. The bindings carry the limit, and the engine refuses a start past it. Before sending a change back, the stage reads where the limit stands (`startLimits` in `archon workflow runs --item <key> --json`); when none is left, it asks instead, with what is still wrong. Answer `send-back` to allow one more round, `take-as-is` to go on, `replan` to plan again, or `stop`.

## Landing

The land stage merges what the project's land policy calls clear and asks about the rest. The pack's default merges a small, clear change whose review approved its head and whose checks are green, and asks about schema, auth, large or partial changes. A project that wants every merge asked says so in its own `.archon/sdlc/policy/land.md`; Archon's own repository does. An approval holds at the head the question named: a push since then voids it, and the stage asks again.

Nothing merges while the base branch's CI is red. The land stage merges pinned to the head whose checks it read, so a pull request that moved since is refused rather than merged, and it records the merge on the item (`archon workflow runs --item` shows it as merged).

## Discoveries

When a change lands, the discoveries stage reads what the item's runs recorded outside their change, verifies each record against the landing branch, and files at most three new issues a pass. It labels none of them: label one `archon-triage` to put it in the factory.

## A stage that did not start

A binding's start can be refused or left unmatched, for example when a result names nothing the binding reads, or when the checkout a stage was to continue is gone. The run that ended still completes, and the command that ended it prints that the next stage was not started. `archon trigger list` shows the receipt with its reason, and `archon trigger inspect <id>` the detail.

- **A stage that starts on a fresh checkout** (triage, link, investigate, split, plan, discoveries, and the first build): fix the file, then start it with the inputs the binding would have passed: `archon trigger fire --config ~/.archon/triggers/<file>.json --item issue-<n> --inputs inputs.json`, or `archon workflow run <stage> --item issue-<n> --input issue=<n>`.
- **A stage that continues a checkout** (review, host, land, and a build that continues a change): a fire cannot take a checkout. Adopt the run that holds it: `archon workflow run <stage> --adopt <run-id> --item issue-<n> --input issue=<n>`. For a start after a read-only stage, adopt the run whose checkout that stage was given, `metadata.checkout_handoff.runId` in `archon workflow get <run-id> --json`, or for an answer, `metadata.asks_checkout.handoff.runId`. See [work in the checkout the ended run left](/guides/workflow-triggers/#work-in-the-checkout-the-ended-run-left).

## Metrics

The pack declares four per-item figures in `.shared/item-metrics.json`, which `archon metrics --project <project>` reports over a window under `item_metrics`:

| Metric | What it is |
|---|---|
| `sdlc.item_merge_rate` | The share of items with a build run whose change merged |
| `sdlc.item_build_rounds` | Build runs per merged item |
| `sdlc.item_lead_time` | From the item's first triage run to its merge |
| `sdlc.item_answers` | Answers an operator gave per merged item |

See [item metrics a pack declares](/guides/metrics/#item-metrics-a-pack-declares).
