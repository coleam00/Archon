# Assign a default workflow to a project

**Labels:** `enhancement`

---

## Problem

- **What problem are you trying to solve?**

  A registered project used as an intake surface (a Slack channel, a Telegram chat) has no
  way to say "every message here always runs workflow X." Every plain message goes through
  the AI router, which is probabilistic — it can pick the wrong workflow, or none — and the
  only deterministic escape hatch is retyping `/workflow run <name> ...` on every message.

- **Who experiences it?**

  Operators running Archon against a channel that is really an intake pipeline, not a
  conversation (e.g. an inbox that only ever logs notes or ingests receipts).

- **How often does it come up?**

  Every plain message in that project's conversations, for as long as the project is used
  that way.

## Proposed Solution

A global-only `defaultWorkflows:` table maps a registered project name to a workflow name.
Enforced once at Archon's shared message-intake seam (`handleMessage`), so every platform
(Slack, Telegram, Discord, GitHub, web, CLI) gets it with zero adapter-specific code.

```yaml
# ~/.archon/config.yaml
defaultWorkflows:
  acme/support-inbox: intake-workflow # <registered project name>: <workflow name>

defaultWorkflowBypass: '* ' # optional; bypasses the default workflow for one message
```

Two escape hatches, both of which post an in-thread notice before falling through — the
bypass must never be silent:

1. A configured `defaultWorkflowBypass` prefix at the start of the message.
2. A slash command (`/word...`).

`defaultWorkflowBypass` has **no built-in default** — if it's unset or blank, only a slash
command can escape a mapped project.

## User Flow

### Before (current)

```
Slack #intake, project bound to the channel

  user> log this receipt
        [!] AI router picks *a* workflow — probabilistic, may pick wrong

  user> /workflow run intake-workflow log this receipt
        [!] deterministic, but the workflow name must be retyped EVERY message
```

### After (proposed)

```
Slack #intake, project bound + listed in defaultWorkflows:

  user> log this receipt
        [+] runs `intake-workflow` directly — router SKIPPED, deterministic

  user> * what did I log today
        [+] "Bypass sigil '* ' detected, bypassing default workflow: intake-workflow"
        [+] falls through -> normal AI chat, sees "what did I log today"

  user> /workflow list
        [+] "Command (slash) detected, bypassing default workflow: intake-workflow"
        [+] then the slash command runs as it always does

  (project NOT in defaultWorkflows:, or no project bound)
  user> anything
        unchanged — normal AI routing, byte for byte
```

## Alternatives Considered

| Alternative                                                                           | Pros                                     | Cons                                                                                                        | Why not chosen                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-adapter mapping (e.g. extend Slack channel→project config with a workflow column) | Sits next to existing per-adapter config | Needs per-adapter code in Slack, Telegram, Discord, GitHub; leaves web/CLI uncovered                        | The behavior is platform-agnostic — one shared intake seam covers all six sources                                                                                           |
| Strengthen the router prompt ("prefer workflow X in this project")                    | No new config, no code                   | Still probabilistic — the whole point is removing the guess                                                 | Doesn't solve the stated problem                                                                                                                                            |
| A workflow-level `trigger:`/`binds_to:` YAML field                                    | Colocates the binding with the workflow  | The engine resolves a flat static DAG at load time; a workflow file cannot know install-level project names | Rejected by the [Workflow Language Constitution](https://archon.diy/reference/workflow-language-constitution/) — this is routing policy, not something a workflow expresses |
| Repo-level `.archon/config.yaml` key                                                  | Lives with the project it affects        | Keys are install-level names the repo cannot know; folder projects have no repo at all                      | Physically cannot express the mapping                                                                                                                                       |
| Silent bypass (no in-thread notice)                                                   | Less chatty                              | A silent escape is the failure mode hardest to notice — "why did it stop running my workflow?"              | Both escape rules explicitly post a notice first                                                                                                                            |

## Scope

- Package(s) likely affected: `core`, `docs`
- Breaking change? `No` — with no `defaultWorkflows:` key configured, routing is byte-for-byte
  identical to today.
- Database changes needed? `No`
- New external dependencies? `No`

## Security Considerations

- New permissions/capabilities? `No` — dispatch changes _which_ workflow runs, never _what a
  workflow is permitted to do_. An intercepted message runs through the same
  `handleWorkflowRunCommand` path as a manual `/workflow run`, so isolation resolution and
  `requires:` gates behave identically.
- New external network calls? `No`
- Secrets/tokens handling? `No`
- If any `Yes`, describe: n/a — `defaultWorkflows:`/`defaultWorkflowBypass:` are non-secret
  config, never logged, and appear only in in-thread notices that already name the workflow.

## Definition of Done

- [x] A global-only `defaultWorkflows:` table maps a registered project name to a workflow name
- [x] Every non-slash message in a conversation bound to a listed project runs that workflow,
      bypassing the AI router
- [x] Enforced once at the shared message-intake seam — no per-adapter code
- [x] A configured bypass prefix escapes a single message back to normal AI chat, posting an
      in-thread notice first
- [x] A slash command escapes the same way, posting its own in-thread notice first
- [x] No built-in default bypass prefix — unset/blank means only a slash command can escape
- [x] Unlisted projects, and conversations with no project bound, are unaffected byte-for-byte
- [x] An open approval gate still takes precedence over dispatch
- [x] An unresolvable or ambiguous workflow name reports in-thread and runs nothing
- [x] Tests covering the feature
- [x] Documentation updated (configuration reference + config template)
