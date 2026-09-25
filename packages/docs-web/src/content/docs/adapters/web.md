---
title: Web UI
description: Built-in console for operating Archon from a browser.
category: adapters
area: adapters
audience: [user]
status: current
sidebar:
  order: 1
---

The Web UI is Archon's built-in management console. It uses Archon's public API
and does not require a separate hosted service.

## Start the console

For local development, start the API server and Vite frontend together:

```bash
bun run dev
```

The console is available at `http://localhost:5173`; the API server listens on
`http://localhost:3090`.

You can also run them separately:

```bash
bun run dev:server
bun run dev:web
```

For a production build, the API server serves the compiled console on port 3090:

```bash
bun run build
bun run start
```

The backend binds to `0.0.0.0` by default. The Vite development server binds to
localhost; pass `--host 0.0.0.0` only when you intentionally want to expose it:

```bash
bun run dev:web -- --host 0.0.0.0
```

## Authentication

Authentication is optional. A solo installation with Web authentication disabled
opens the console directly. When authentication is enabled, the same console
requires a session and provides sign-in, signup when allowed by server policy,
and sign-out.

## Console navigation

The project rail is the main navigation surface:

- **Runs** at `/console` shows runs across projects. Selecting a
  project opens its scoped runs at `/console/p/:projectId`.
- **Chat** at `/console/p/:projectId/chat` opens the operator conversation for
  that project.
- **Settings** at `/console/settings` manages assistant defaults, model tiers,
  aliases, provider credentials, system status, and GitHub identity.
- **Workflow builder** at `/console/builder` opens the experimental visual
  authoring surface. Select a project before opening or creating a workflow.

Register a project with the add button in the rail. Remote Git URLs are cloned;
local paths are registered in place. Removing a project removes its registration,
not its files.

## Workflows and runs

Choose a workflow from a project's run or chat view, supply its inputs, and
launch it. The console follows execution through live events and exposes the
governance actions that apply to the current state, including approval, rejection,
resume, cancel, and abandon.

A run can be opened from a project at
`/console/p/:projectId/r/:runId` or directly by ID at
`/console/r/:runId`. Direct links also work for runs that have no registered
project. Run details include the event log and artifacts; a graph is shown when
the run has the project context needed to load its workflow definition.

Old settings, workflow-list, workflow-builder, and run bookmarks redirect to the
closest console route. Old chat and other retired pages land on the console
overview because the conversation browser is no longer shipped.

## Project chat

Project chat streams assistant text and tool activity. When Web authentication
is enabled, the console requests the signed-in user's project conversation and
sends the active identity with each turn. On a solo installation, chat works
without a user identity.

Attachments are limited to five files of at most 10 MB each. The first message in
a new conversation cannot include attachments; create the conversation with a
text message, then attach files on the next turn.

## Experimental workflow builder

The builder is retained as a bounded experiment inside the console. Use its
canvas, inspector, validation, and YAML preview to draft new workflows with
prompt, command, bash, script, loop, approval, wait, and cancel nodes. Editing an
existing workflow and relying on a load/edit/save round trip is not supported
until [#3378](https://github.com/coleam00/Archon/pull/3378) and
[#3379](https://github.com/coleam00/Archon/pull/3379) land. Edit existing
workflows as YAML. The builder also does not represent include directives, loop
groups, or workflow sub-run nodes. Workflow YAML remains the authoritative
artifact.

## Further reading

- [Getting Started](/getting-started/overview/)
- [Configuration](/getting-started/configuration/)
- [Authoring Workflows](/guides/authoring-workflows/)
- [API Reference](/reference/api/)
