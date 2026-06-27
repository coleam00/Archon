#!/bin/bash
# OpenAI Codex driver for Ralph
# Provides platform-specific CLI invocation logic for Codex

driver_name() {
    echo "codex"
}

driver_display_name() {
    echo "OpenAI Codex"
}

driver_cli_binary() {
    echo "codex"
}

driver_min_version() {
    echo "0.1.0"
}

driver_check_available() {
    command -v "$(driver_cli_binary)" &>/dev/null
}

# Codex tool names differ from Claude Code
driver_valid_tools() {
    VALID_TOOL_PATTERNS=(
        "shell"
        "read_file"
        "write_file"
        "edit_file"
        "list_directory"
        "search_files"
    )
}

driver_supports_tool_allowlist() {
    return 1
}

driver_permission_denial_help() {
    echo "  - $DRIVER_DISPLAY_NAME uses its native sandbox and approval model."
    echo "  - ALLOWED_TOOLS in $RALPHRC_FILE is ignored for this driver."
    echo "  - Ralph already runs Codex with --sandbox workspace-write."
    echo "  - Review Codex approval settings, then restart the loop."
}

# Build Codex CLI command
# Codex uses: codex exec [resume <id>] --json "prompt"
driver_build_command() {
    local prompt_file=$1
    local loop_context=$2
    local session_id=$3

    CLAUDE_CMD_ARGS=("$(driver_cli_binary)" "exec")

    if [[ ! -f "$prompt_file" ]]; then
        echo "ERROR: Prompt file not found: $prompt_file" >&2
        return 1
    fi

    # JSON output
    CLAUDE_CMD_ARGS+=("--json")

    # Sandbox mode - workspace write access
    CLAUDE_CMD_ARGS+=("--sandbox" "workspace-write")

    # Session resume — gated on CLAUDE_USE_CONTINUE to respect --no-continue flag
    if [[ "$CLAUDE_USE_CONTINUE" == "true" && -n "$session_id" ]]; then
        CLAUDE_CMD_ARGS+=("resume" "$session_id")
    fi

    # Build prompt with context
    local prompt_content
    prompt_content=$(cat "$prompt_file")
    if [[ -n "$loop_context" ]]; then
        prompt_content="$loop_context

$prompt_content"
    fi

    CLAUDE_CMD_ARGS+=("$prompt_content")
}

driver_supports_sessions() {
    return 0  # true - Codex supports session resume
}

# Codex JSONL output is already suitable for live display.
driver_supports_live_output() {
    return 0  # true
}

driver_prepare_live_command() {
    LIVE_CMD_ARGS=("${CLAUDE_CMD_ARGS[@]}")
}

# Codex outputs JSONL events
driver_stream_filter() {
    echo 'select(.type == "item.completed" and .item.type == "agent_message") | (.item.text // ([.item.content[]? | select(.type == "output_text") | .text] | join("\n")) // empty)'
}
