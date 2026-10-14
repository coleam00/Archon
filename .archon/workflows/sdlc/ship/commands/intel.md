# Gather usage data for the plan

A planner is about to make the design calls for one work item. Decide whether data about how people use the product could change one of those calls, and fetch that data only when it could. Write what you found to `$ARTIFACTS_DIR/intel.md`. No one watches this run; that file is all the planner reads from you.

The work item's assessment is `$ARTIFACTS_DIR/triage.md`. Read it first: its handoff names the decisions the planner owns.

The operator's request — the message that started this run:

$ARGUMENTS

## Judge relevance first

Usage data is relevant when a design call turns on how the product is used: which of two behaviors people depend on, how often a path runs, whether a setting is ever changed from its default, which errors users hit. Most internal changes, such as a refactor, a type fix, or a build change, turn on none of that. When no call in the handoff could change with the data, write one line to `intel.md` saying so and why, and stop.

## Query only what could change a call

Use the product-analytics tools this node was given, such as a PostHog MCP server. When it has none, write one line to `intel.md` saying no usage-data source is connected, and stop. Never reach for credentials, tokens, or services this node was not given.

When a source is connected, ask the few questions whose answers could change a call, and nothing else. For each one, record in `intel.md`:

- the design call it bears on;
- the query you ran, and the time range it covers;
- the result, with the numbers;
- what the result means for the call, and what it cannot tell you.

Report aggregates. Never copy a person's identity, contact details, or message content into the report.

## Not your job

Do not plan, decide the design, or modify the checkout. Scratch notes live under `$ARTIFACTS_DIR` only.
