# PRD: Default Workflow Assignment per Project (`defaultWorkflows`)

- **Status:** Implemented
- **Branch:** `feat/project-default-workflow-dispatch`
- **Packages touched:** `@archon/core` (`config/config-types.ts`, `config/config-loader.ts`,
  `orchestrator/dispatch.ts` [new], `orchestrator/orchestrator-agent.ts`), docs

## 1. Problem

A registered project used as an intake surface (a Slack channel, a Telegram chat) has no way
to say "every message here always runs workflow X." Today every plain message goes through
the AI router, which is probabilistic, or the user has to retype `/workflow run <name>` on
every message.

## 2. Configuration

Global-only, in `~/.archon/config.yaml`:

```yaml
defaultWorkflows:
  acme/support-inbox: intake-workflow # <registered project name>: <workflow name>

defaultWorkflowBypass: '* ' # prefix that bypasses the default workflow for one message
```

- `defaultWorkflows` — map of registered project name → workflow name. Global-only: keys are
  install-level project names (`/register-project`, `/setproject`) a repo's own config
  cannot know, and folder projects have no repo at all.
- `defaultWorkflowBypass` — optional prefix string. If unset (or blank), the bypass rule
  never matches (bypass is then only possible via a slash command). Leading whitespace on
  the configured value is stripped before matching, so `' * '` and `'* '` behave
  identically; trailing whitespace is kept, since a separator is what makes a prefix
  deliberate rather than accidental.

## 3. Rules

Applied only inside a conversation whose project has an entry in `defaultWorkflows`.
Everywhere else, nothing changes. In order:

1. **Bypass sigil detected** → let Archon handle the message normally (AI router), but first
   post: `Bypass sigil '{bypassSigil}' detected, bypassing default workflow: {workflow}`
2. **Slash command detected** (message starts with `/`, including a bare `/`) → let Archon
   handle it normally, but first post: `Command (slash) detected, bypassing default workflow: {workflow}`
3. **Otherwise** → run `{workflow}` directly, with the message as its input. AI router is
   skipped.

That's the whole policy — no other precedence rules, no project-name fuzzy matching beyond
an exact-then-case-insensitive key lookup.

## 4. Design

### 4.1 Policy module — `packages/core/src/orchestrator/dispatch.ts`

A pure, I/O-free function: the whole decision is a function of the message text, the bound
project's name, the `defaultWorkflows:` table, and the configured bypass prefix. No DB, no
adapter, no config read inside it — unit-testable in isolation (18 tests, no mocking).

```ts
export type DispatchDecision =
  | { kind: 'chat'; message: string; notice?: string }
  | { kind: 'workflow'; workflowName: string; message: string };

export function resolveDispatch(
  message: string,
  codebaseName: string | undefined,
  defaultWorkflows: Record<string, string> | undefined,
  configuredBypass?: string
): DispatchDecision;
```

### 4.2 Wiring into `handleMessage` — `orchestrator-agent.ts`

Enforced once at the single seam every platform already funnels through, so Slack,
Telegram, Discord, GitHub, web, and CLI all get it with zero per-adapter code.

Placement matters:

- **After** the paused-approval branch — an open approval gate still wins.
- **Before** the deterministic-command branch — a recognized command like `/workflow list`
  returns early from that block, so dispatch must run first or the bypass notice would never
  fire for exactly the slash commands most likely to be typed in a dispatched project.
  Archon still executes the command normally afterward; dispatch only posts the notice and
  lets the message continue.
- **Before** message persistence — a dispatched turn creates no orphan user row, matching
  how `/workflow run` already behaves.

Two new internal helpers:

- `resolveConversationDispatch(conversation, message)` — short-circuits cheaply: an
  unscoped conversation costs nothing; an install with no `defaultWorkflows:` configured (the
  common case) costs one memoized `loadConfig()` read and never touches the database; only a
  project actually listed pays for a `getCodebase()` lookup.
- `runDefaultWorkflow(...)` — reuses `handleWorkflowRunCommand`, the exact same path
  `/workflow run` takes, so isolation resolution, `requires:` gates, and resume detection all
  behave identically regardless of how the workflow was chosen.

### 4.3 Failure handling

A configured-but-unresolvable workflow name (typo, deleted workflow, ambiguous fuzzy match)
is reported in-thread and **nothing runs** — never silently forwarded to the AI router. A
plausible-looking AI reply is the hardest kind of failure to notice from inside a chat
thread (Fail Fast + Explicit Errors). Logged at `error` with dedicated event names:
`orchestrator.default_workflow_not_found`, `orchestrator.default_workflow_ambiguous`;
successful hand-off logs `orchestrator.default_workflow_started` /
`orchestrator.default_workflow_completed`.

## 5. Non-Goals

- No new workflow YAML surface (no `trigger:` field on a workflow) — this is install-level
  routing, not something a workflow file can express.
- No repo-level config — `defaultWorkflows` is global-only, same reasoning as above.
- No per-adapter code.
- No attachment handling bundled into this feature.

## 6. Edge Cases

| Case                                                     | Behavior                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Project not in `defaultWorkflows`                        | Untouched — normal AI routing                                                  |
| `defaultWorkflowBypass` unset or blank                   | Bypass sigil rule never fires; slash commands still bypass                     |
| Configured bypass value has leading whitespace (`' * '`) | Normalized to match `'* '` — leading whitespace on the config value is ignored |
| Configured workflow name doesn't resolve                 | Reported in-thread, nothing runs — never silently falls through to the AI      |
| Open approval gate in the thread                         | Gate wins; reply answers the gate, not the default workflow                    |
| Bare slash with no word characters (`/`)                 | Still counts as a slash command — any leading `/` bypasses, recognized or not  |
| Project key casing mismatch                              | Falls back to case-insensitive match                                           |

## 7. Testing

- `packages/core/src/orchestrator/dispatch.test.ts` — 18 tests covering all three rules,
  ordering, the no-built-in-default guarantee, empty/whitespace bypass rejection, leading-
  whitespace normalization on the configured bypass value, slash-command edge cases, and
  case-insensitive project matching.
- `orchestrator-agent.test.ts` — two pre-existing tests updated: the dispatch check's extra
  `loadConfig()` read (now happening before workflow discovery's own read) meant two
  `mockResolvedValueOnce` mocks needed to become persistent `mockResolvedValue`.
- Full `@archon/core` suite (`bun run test`), `bun run type-check`, and `bun run lint` all
  green.

## 8. Definition of Done

- [x] `defaultWorkflows:` (global-only) maps a registered project name to a workflow name
- [x] `defaultWorkflowBypass:` (optional, global-only) configures the bypass prefix
- [x] Bypass-sigil messages post the exact notice above, then route to normal AI chat
- [x] Slash-command messages post the exact notice above, then route as slash commands
      always do
- [x] Any other message in a mapped project runs the default workflow directly
- [x] Projects not listed, and conversations with no project bound, are unaffected
- [x] An open approval gate still takes precedence
- [x] An unresolvable workflow name reports in-thread and runs nothing
- [x] Tests covering all three rules
- [x] Documentation updated (configuration reference + config template)

## 9. Known Environment Prerequisite (Windows)

> **⚠️ WARN:** live-testing this feature against a real project (an Obsidian vault
> with deeply nested, long file paths) surfaced a pre-existing Windows/git limitation
> unrelated to `defaultWorkflows` itself, but blocking enough that it's worth calling
> out here: dispatching to a workflow that needs isolation (a fresh `git worktree add`)
> failed with `error: unable to create file ...: Filename too long` for every path
> whose full length — repo path + worktree destination + relative file path — exceeded
> Windows' 260-character `MAX_PATH`.
>
> **Fix required:** `git config core.longpaths true`, set globally
> (`git config --global core.longpaths true`) so it covers every repo, not just the
> one that triggered it. This is a one-time, machine-level git setting — not something
> `defaultWorkflows`, Archon, or this workflow's YAML can work around, since the failure
> happens inside git's own checkout step before Archon regains control.
>
> Anyone testing `defaultWorkflows` (or any workflow that creates a worktree) against a
> project with long nested paths on Windows should set this **before** their first run,
> not after hitting the same opaque git error.
