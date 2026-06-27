#!/bin/bash
# Cursor CLI driver for Ralph
# Uses the documented cursor-agent contract for background execution and
# switches to stream-json only for live display paths.

driver_name() {
    echo "cursor"
}

driver_display_name() {
    echo "Cursor CLI"
}

driver_cli_binary() {
    local binary
    binary=$(driver_resolve_cli_binary)

    if [[ -n "$binary" ]]; then
        echo "$binary"
        return 0
    fi

    echo "cursor-agent"
}

driver_min_version() {
    echo "0.1.0"
}

driver_check_available() {
    local cli_binary
    cli_binary=$(driver_cli_binary)

    if [[ -f "$cli_binary" ]]; then
        return 0
    fi

    command -v "$cli_binary" &>/dev/null
}

driver_valid_tools() {
    VALID_TOOL_PATTERNS=(
        "file_edit"
        "file_read"
        "file_write"
        "terminal"
        "search"
    )
}

driver_supports_tool_allowlist() {
    return 1
}

driver_permission_denial_help() {
    echo "  - $DRIVER_DISPLAY_NAME uses its native permission model."
    echo "  - ALLOWED_TOOLS in $RALPHRC_FILE is ignored for this driver."
    echo "  - Ralph already runs Cursor with --force."
    echo "  - Review Cursor permissions or approval settings, then restart the loop."
}

driver_build_command() {
    local prompt_file=$1
    local loop_context=$2
    local session_id=$3
    local cli_binary
    cli_binary=$(driver_cli_binary)

    if [[ ! -f "$prompt_file" ]]; then
        echo "ERROR: Prompt file not found: $prompt_file" >&2
        return 1
    fi

    CLAUDE_CMD_ARGS=()
    if [[ "$cli_binary" == *.cmd ]]; then
        CLAUDE_CMD_ARGS+=("$(driver_wrapper_path)" "$cli_binary")
    else
        CLAUDE_CMD_ARGS+=("$cli_binary")
    fi

    CLAUDE_CMD_ARGS+=("-p" "--force" "--output-format" "json")

    if [[ "$CLAUDE_USE_CONTINUE" == "true" && -n "$session_id" ]]; then
        CLAUDE_CMD_ARGS+=("--resume" "$session_id")
    fi

    local prompt_content
    if driver_running_on_windows; then
        prompt_content=$(driver_build_windows_bootstrap_prompt "$loop_context" "$prompt_file")
    else
        prompt_content=$(cat "$prompt_file")
        if [[ -n "$loop_context" ]]; then
            prompt_content="$loop_context

$prompt_content"
        fi
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
    LIVE_CMD_ARGS=()
    local skip_next=false

    for arg in "${CLAUDE_CMD_ARGS[@]}"; do
        if [[ "$skip_next" == "true" ]]; then
            LIVE_CMD_ARGS+=("stream-json")
            skip_next=false
        elif [[ "$arg" == "--output-format" ]]; then
            LIVE_CMD_ARGS+=("$arg")
            skip_next=true
        else
            LIVE_CMD_ARGS+=("$arg")
        fi
    done

    if [[ "$skip_next" == "true" ]]; then
        return 1
    fi
}

driver_stream_filter() {
    echo '
        if .type == "assistant" then
            [(.message.content[]? | select(.type == "text") | .text)] | join("\n")
        elif .type == "tool_call" then
            "\n\n⚡ [" + (.tool_call.name // .name // "tool_call") + "]\n"
        else
            empty
        end'
}

driver_running_on_windows() {
    [[ "${OS:-}" == "Windows_NT" || "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* || "${OSTYPE:-}" == win32* ]]
}

driver_resolve_cli_binary() {
    local candidate
    local resolved
    local fallback
    local candidates=(
        "cursor-agent"
        "cursor-agent.cmd"
        "agent"
        "agent.cmd"
    )

    for candidate in "${candidates[@]}"; do
        resolved=$(driver_lookup_cli_candidate "$candidate")
        if [[ -n "$resolved" ]]; then
            echo "$resolved"
            return 0
        fi
    done

    fallback=$(driver_localappdata_cli_binary)
    if [[ -n "$fallback" ]]; then
        echo "$fallback"
        return 0
    fi

    echo ""
}

driver_lookup_cli_candidate() {
    local candidate=$1
    local resolved

    resolved=$(command -v "$candidate" 2>/dev/null || true)
    if [[ -n "$resolved" ]]; then
        echo "$resolved"
        return 0
    fi

    if ! driver_running_on_windows; then
        return 0
    fi

    driver_find_windows_path_candidate "$candidate"
}

driver_find_windows_path_candidate() {
    local candidate=$1
    local path_entry
    local normalized_entry
    local resolved_candidate
    local path_entries="${PATH:-}"
    local -a path_parts=()

    if [[ "$path_entries" == *";"* ]]; then
        IFS=';' read -r -a path_parts <<< "$path_entries"
    else
        IFS=':' read -r -a path_parts <<< "$path_entries"
    fi

    for path_entry in "${path_parts[@]}"; do
        [[ -z "$path_entry" ]] && continue

        normalized_entry=$path_entry
        if command -v cygpath &>/dev/null && [[ "$normalized_entry" =~ ^[A-Za-z]:\\ ]]; then
            normalized_entry=$(cygpath -u "$normalized_entry")
        fi

        resolved_candidate="$normalized_entry/$candidate"
        if [[ -f "$resolved_candidate" ]]; then
            echo "$resolved_candidate"
            return 0
        fi
    done
}

driver_localappdata_cli_binary() {
    local local_app_data="${LOCALAPPDATA:-}"

    if [[ -z "$local_app_data" ]] || ! driver_running_on_windows; then
        return 0
    fi

    if command -v cygpath &>/dev/null && [[ "$local_app_data" =~ ^[A-Za-z]:\\ ]]; then
        local_app_data=$(cygpath -u "$local_app_data")
    fi

    local candidates=(
        "$local_app_data/cursor-agent/cursor-agent.cmd"
        "$local_app_data/cursor-agent/agent.cmd"
    )

    local candidate
    for candidate in "${candidates[@]}"; do
        if [[ -f "$candidate" ]]; then
            echo "$candidate"
            return 0
        fi
    done
}

driver_wrapper_path() {
    local driver_dir
    driver_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    echo "$driver_dir/cursor-agent-wrapper.sh"
}

driver_build_windows_bootstrap_prompt() {
    local loop_context=$1
    local prompt_file=$2

    cat <<EOF
Read these Ralph workspace files before taking action:
- .ralph/PROMPT.md
- .ralph/PROJECT_CONTEXT.md
- .ralph/SPECS_INDEX.md
- .ralph/@fix_plan.md
- .ralph/@AGENT.md
- relevant files under .ralph/specs/

Then follow the Ralph instructions from those files and continue the next task.
EOF

    if [[ -n "$loop_context" ]]; then
        cat <<EOF

Current loop context:
$loop_context
EOF
    fi

    if [[ "$prompt_file" != ".ralph/PROMPT.md" ]]; then
        cat <<EOF

Also read the active prompt file if it differs:
- $prompt_file
EOF
    fi
}
