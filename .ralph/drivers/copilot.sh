#!/bin/bash
# GitHub Copilot CLI driver for Ralph (EXPERIMENTAL)
# Provides platform-specific CLI invocation logic for Copilot CLI.
#
# Known limitations:
# - No session continuity (session IDs not capturable from -p output)
# - No structured output (plain text only, no --json flag)
# - Coarse tool permissions (only shell, shell(git:*), shell(npm:*), write)
# - CLI is new (GA Feb 25, 2026) — scripting interface may change

driver_name() {
    echo "copilot"
}

driver_display_name() {
    echo "GitHub Copilot CLI"
}

driver_cli_binary() {
    echo "copilot"
}

driver_min_version() {
    echo "0.0.418"
}

driver_check_available() {
    command -v "$(driver_cli_binary)" &>/dev/null
}

# Copilot CLI tool names
driver_valid_tools() {
    VALID_TOOL_PATTERNS=(
        "shell"
        "shell(git:*)"
        "shell(npm:*)"
        "write"
    )
}

driver_supports_tool_allowlist() {
    return 1
}

driver_permission_denial_help() {
    echo "  - $DRIVER_DISPLAY_NAME uses its own autonomy and approval controls."
    echo "  - ALLOWED_TOOLS in $RALPHRC_FILE is ignored for this driver."
    echo "  - Ralph already runs Copilot with --no-ask-user for unattended mode."
    echo "  - Review Copilot CLI permissions, then restart the loop."
}

# Build Copilot CLI command
# Context is prepended to the prompt (same pattern as Codex driver).
# Uses --autopilot --yolo for autonomous mode, -s to strip stats, -p for prompt.
driver_build_command() {
    local prompt_file=$1
    local loop_context=$2
    # $3 (session_id) is intentionally ignored — Copilot CLI does not
    # expose session IDs in -p output, so resume is not possible.

    CLAUDE_CMD_ARGS=("$(driver_cli_binary)")

    if [[ ! -f "$prompt_file" ]]; then
        echo "ERROR: Prompt file not found: $prompt_file" >&2
        return 1
    fi

    # Autonomous execution flags
    CLAUDE_CMD_ARGS+=("--autopilot" "--yolo")

    # Limit auto-continuation loops
    CLAUDE_CMD_ARGS+=("--max-autopilot-continues" "50")

    # Disable interactive prompts
    CLAUDE_CMD_ARGS+=("--no-ask-user")

    # Strip stats for cleaner output
    CLAUDE_CMD_ARGS+=("-s")

    # Build prompt with context prepended
    local prompt_content
    prompt_content=$(cat "$prompt_file")
    if [[ -n "$loop_context" ]]; then
        prompt_content="$loop_context

$prompt_content"
    fi

    CLAUDE_CMD_ARGS+=("-p" "$prompt_content")
}

driver_supports_sessions() {
    return 1  # false — session IDs not capturable from -p output
}

# Copilot CLI does not expose structured live output for jq streaming.
driver_supports_live_output() {
    return 1  # false
}

# Copilot CLI outputs plain text only (no JSON streaming).
# Passthrough filter — no transformation needed.
driver_stream_filter() {
    echo '.'
}
