#!/bin/bash
# OpenCode driver for Ralph
# Uses OpenCode's build agent with JSON event output and optional session resume.

driver_name() {
    echo "opencode"
}

driver_display_name() {
    echo "OpenCode"
}

driver_cli_binary() {
    echo "opencode"
}

driver_min_version() {
    echo "0.1.0"
}

driver_check_available() {
    command -v "$(driver_cli_binary)" &>/dev/null
}

driver_valid_tools() {
    VALID_TOOL_PATTERNS=(
        "bash"
        "read"
        "write"
        "edit"
        "grep"
        "question"
    )
}

driver_supports_tool_allowlist() {
    return 1
}

driver_permission_denial_help() {
    echo "  - $DRIVER_DISPLAY_NAME uses its native permission and approval model."
    echo "  - ALLOWED_TOOLS in $RALPHRC_FILE is ignored for this driver."
    echo "  - BMAD workflows can use OpenCode's native question tool when needed."
    echo "  - Review OpenCode permissions, then restart the loop."
}

driver_build_command() {
    local prompt_file=$1
    local loop_context=$2
    local session_id=$3

    CLAUDE_CMD_ARGS=("$(driver_cli_binary)" "run" "--agent" "build" "--format" "json")

    if [[ ! -f "$prompt_file" ]]; then
        echo "ERROR: Prompt file not found: $prompt_file" >&2
        return 1
    fi

    if [[ "$CLAUDE_USE_CONTINUE" == "true" && -n "$session_id" ]]; then
        CLAUDE_CMD_ARGS+=("--continue" "--session" "$session_id")
    fi

    local prompt_content
    prompt_content=$(cat "$prompt_file")
    if [[ -n "$loop_context" ]]; then
        prompt_content="$loop_context

$prompt_content"
    fi

    CLAUDE_CMD_ARGS+=("$prompt_content")
}

driver_supports_sessions() {
    return 0
}

driver_supports_live_output() {
    return 0
}

driver_prepare_live_command() {
    LIVE_CMD_ARGS=("${CLAUDE_CMD_ARGS[@]}")
}

driver_stream_filter() {
    echo 'select((.type == "message.updated" or .type == "message.completed") and .message.role == "assistant") | ([.message.parts[]? | select(.type == "text") | .text] | join("\n"))'
}

driver_extract_session_id_from_output() {
    local output_file=$1

    if [[ ! -f "$output_file" ]]; then
        echo ""
        return 1
    fi

    local session_id
    session_id=$(sed -n 's/.*"session"[^{]*{[^}]*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$output_file" | head -n 1 | tr -d '\r')

    echo "$session_id"
    [[ -n "$session_id" && "$session_id" != "null" ]]
}

driver_fallback_session_id() {
    local cli_binary
    cli_binary=$(driver_cli_binary)

    local sessions_json
    sessions_json=$("$cli_binary" session list --format json 2>/dev/null) || {
        echo ""
        return 1
    }

    local session_ids
    if command -v jq >/dev/null 2>&1; then
        session_ids=$(printf '%s' "$sessions_json" | jq -r '
            if type == "array" then
                [.[]?.id // empty]
            elif (.sessions? | type) == "array" then
                [.sessions[]?.id // empty]
            else
                []
            end
            | map(select(length > 0))
            | .[]
        ' 2>/dev/null | tr -d '\r')
    else
        session_ids=$(printf '%s' "$sessions_json" | grep -oE '"id"[[:space:]]*:[[:space:]]*"[^"]+"' | sed 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/' | tr -d '\r')
    fi

    local -a session_id_candidates=()
    local session_id
    while IFS= read -r session_id; do
        if [[ -n "$session_id" && "$session_id" != "null" ]]; then
            session_id_candidates+=("$session_id")
        fi
    done <<< "$session_ids"

    if [[ ${#session_id_candidates[@]} -ne 1 ]]; then
        echo ""
        return 1
    fi

    echo "${session_id_candidates[0]}"
    return 0
}
