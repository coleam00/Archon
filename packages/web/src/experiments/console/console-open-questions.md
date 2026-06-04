# Console agent-chat — open questions & gaps

> Analysis after building the project-scoped chat (declutter + working pill +
> workflow dock + run-detail lifecycle lines) and fixing the live-update
> foundation. Captures what we haven't fully thought through, with
> recommendations on what to look into next. Design notes, not a plan.

## 1. Compaction & "new conversation" (the explicit question)

**Current state.** The console chat is exactly **one persistent conversation per
project** — on open it picks the most-recent `web` conversation, or creates one
on first send. There is **no way to start a fresh chat**, no switcher, no reset.
So a project's chat is a single, ever-growing thread forever.

**Why that's a problem.**

- **Context bloat / cost.** Each turn resumes the same provider session, so
  context (and per-turn cost) grows until something compacts it. A long thread
  gets expensive and the agent gets "confused by its own history."
- **No topic separation.** Real use has parallel topics (debug A, plan B). One
  thread forces them to interleave.
- **No escape hatch.** When the agent goes down a bad path, the user can't say
  "start over" — the orchestrator's `/reset` (session transition) isn't exposed.

**Two layers of "compaction" to be precise about.**

- **Provider context** (the LLM's working memory): the Claude Agent SDK resumes
  via `assistant_session_id` and does its _own_ context compaction (Claude Code
  behavior). We mostly inherit this — but Pi/Codex may differ; verify each.
- **DB message history** (what the UI loads): grows unbounded; `listMessages`
  caps at 500, so very old turns silently fall off the top of the chat. That cap
  is invisible to the user.

**Recommendations (look into, roughly in order):**

1. **Expose "New chat."** A button that creates a fresh conversation (already a
   one-liner: `createConversation(projectId)`) and switches to it. Immediate
   escape hatch; unblocks everything below. Pair with surfacing the orchestrator
   `/reset` semantics (deactivate the old session) so context truly resets.
2. **Conversation switcher** (the deferred multi-conversation sidebar). We
   already have `listConversations(projectId)` + server-side auto-titles. Let the
   user list / resume / title / delete threads. This makes "continue vs. start
   fresh" a first-class choice and is the natural home for #1.
3. **Surface cost + turn count** in the chat header (the `session_info` SSE event
   carries cost). Gives the user a signal for _when_ to start fresh, and makes
   the cost of a long thread visible.
4. **"Summarize & start fresh"** — a new conversation seeded with a summary of
   the old one. This is the bridge to deferred _project memory_ (§8 of the spike
   doc): the summary becomes durable project context.
5. **Decide the DB-history policy** — paginate/lazy-load older messages, or
   accept the 500 cap but tell the user ("showing last 500"). Silent truncation
   is the current trap.

## 2. The core hypothesis — `manage_run` Wave 1 shipped

The whole thesis — _the agent helps you run/track/manage workflows_ — needed the
`manage_run` native tool. **Shipped in this PR (Wave 1):** a provider-neutral tool
exposing `list`/`get`/`start`/`resume`/`cancel`/`abandon`/`approve`/`reject` (+ a
`help` action for progressive disclosure), wired for Claude (in-process MCP) and
Pi (`customTools`), project-scoped, with a confirm gate on destructive actions.
The chat agent is now an _operator_, not just a talker. **Deferred:**
Codex/OpenCode (served-MCP, a later wave); agent-initiated `approve`/`reject` is
state-only (no auto-resume — the dock's human path owns that).

## 3. Live-repo mutation risk (safety — look into early)

Direct chat runs the agent in the project's **live checkout** (`codebase.cwd`),
**not** a worktree. If the agent uses Edit/Write/Bash it mutates the user's real
repo with no isolation, no diff review, no rollback. Workflows isolate by default
(worktrees); chat does not. Questions:

- Is chat meant to be read-mostly, or can it edit? If it can edit, do we want
  worktree isolation for chat turns, or at least a guardrail / tool restriction
  (deny Write/Edit by default; allow opt-in)?
- This interacts with CLAUDE.md's "git as first-class" + isolation philosophy.
  Worth an explicit decision before the agent gets more autonomous (`manage_run`,
  workflow authoring).

## 4. Workflow dispatch is invisible in the chat

When the agent dispatches a workflow (today via the `/invoke-workflow` text
protocol), the chat **hides** the dispatch (declutter filters system/dispatch
rows). The workflow appears only in the dock. Recommendation: surface a compact,
meaningful **"▶ Started workflow X →"** line inline in the chat (not a raw system
row) that links to the run, so the conversation records _what it kicked off_. The
dock shows live progress; the inline line gives causality.

## 5. Approvals from chat — inline approvals shipped

**Shipped in this PR:** the WorkflowDock renders **approve/reject inline**
(reusing `ApprovalPanel` + `ApprovalContext`), so the user can act on a paused
gate without leaving the chat. Remaining: the RunsPage pending-input banner still
doesn't extend to the chat surface, and `manage_run`'s agent-initiated
`approve`/`reject` is state-only (the dock's human path handles auto-resume).

## 6. Streaming granularity

The console model shows **persisted messages** (appear when the turn/segment is
written), not **token-by-token** streaming — the backend emits `text` token
events but we only use them as refetch triggers. The working pill hides the gap,
but long replies still pop in all at once. Decide whether token-streaming is
worth reintroducing for "aliveness," or whether the pill + segment-on-persist is
good enough (it's much simpler and is what made the live-update fix tractable).

## 7. Error & stuck-turn UX

`useConversationSSE` doesn't special-case the `error` SSE event; a failed turn
relies on the message's error metadata + the `MAX_WAIT_MS` busy cap (5 min) to
unstick the composer. Look into: surface turn errors promptly (and clear `busy`
on an `error` event) rather than waiting out the cap. Also the occasional
**direct-reload-doesn't-load-the-conversation** race (navigation works, reload is
flaky) deserves hardening.

## 8. Smaller gaps worth tracking

- **File attachments** in the composer (backend supports multipart; composer is
  text-only).
- **Provider/model per conversation** — not selectable in chat.
- **Keyboard shortcuts** for chat (new chat, focus composer, approve) — the rest
  of the console is keyboard-driven; chat isn't.
- **`currentNode` only, no `n/total`** in the dock — the dashboard run has step
  counts the `Run` primitive doesn't capture; add for a real progress sense.
- **Working-pill `· <activity>`** depends on the last tool call landing in the
  message metadata mid-turn; verify it populates for fast/parallel tool use.
- **Responsive / mobile** — unconsidered.
- **Multi-tab** — read paths fine (SSE+poll); writes serialize on the server
  lock. Low risk, but confirm.

## Suggested priority to look into

1. ~~`manage_run` tool (Wave 1)~~ — the hypothesis. _(shipped in this PR)_
2. "New chat" + conversation switcher — the §1 escape hatch. _(build, small)_
3. Live-repo mutation policy for chat — safety decision. _(decide)_
4. Inline workflow-dispatch line + ~~inline approvals~~ — close the operator loop. Inline approvals shipped; the inline "▶ Started workflow X" causality line is still open. _(build)_
5. Cost/turn-count surfacing + DB-history policy — context-growth visibility. _(build, small)_
6. Streaming granularity + error UX — polish. _(decide/build)_
