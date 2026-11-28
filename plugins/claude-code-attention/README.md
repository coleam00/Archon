# Archon Attention Plugin for Claude Code

A Claude Code mod plugin that displays Archon's live attention queue in a pane, lets you answer open items with confirmation, exposes a typed `answer_attention` tool, and ships an optional opt-in skill for policy-based automation.

## Compatibility

- **Claude Code CLI**: requires `>= v2.1.287` (mods enabled by default).
- **Verified on**: Claude Code CLI `v2.1.332` (`claude plugin validate`).
- **Archon CLI**: `archon` must be installed and available on `PATH`.

### Surface Limitations

Claude Code mods do not render panes in `claude -p`, the Agent SDK, WSL Desktop sessions, or unsupported cloud sessions. Running `/archon-attention` in a non-drawing environment prints a plain-text summary of open items instead.

## Installation & Usage

Load directly from the Archon repository for a single session:

```bash
claude --plugin-dir ./plugins/claude-code-attention
```

Validate the plugin without launching a session:

```bash
claude plugin validate ./plugins/claude-code-attention
```

Inside Claude Code:

- Run `/archon-attention` to open and focus the live Attention Queue pane.
- Review each item's context, recommendation, declared options, and evidence paths.
- Type an optional ruling note (required when choosing `other`), pick a choice button, and confirm before the plugin executes `archon workflow respond` (for paused runs) or `archon workflow answer --ref` (for completed-run asks) using direct argv arrays with no shell interpolation.
- The pane stays synchronized through `archon workflow attention --all --watch --protocol --json` and reconnects with `--after <cursor>` automatically.

## Typed Tool: `answer_attention`

The plugin registers `mcp__archon-attention__answer_attention` with input `{ ref?, run_id?, choice, text? }`. Before calling the Archon CLI, it checks the live snapshot and refuses any undeclared `choice` or blank ruling text when required.

## Optional Automation Skill

An opt-in skill lives at `skills/archon-attention-auto/SKILL.md`. It is disabled for automatic model invocation by default (`disable-model-invocation: true`).

Invoke `/archon-attention-auto` when you want Claude to evaluate open items strictly against **your repository's own** `AGENTS.md`, `.archon/direction.md`, `.archon/architecture.md`, `.archon/engineering.md`, and prior rulings. The skill contains no project-specific policy of its own and leaves product-direction, ambiguous, or irreversible items for a person.
