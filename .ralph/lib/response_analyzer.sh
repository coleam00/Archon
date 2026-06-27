#!/bin/bash
# Response Analyzer Component for Ralph
# Analyzes Claude Code output to detect completion signals, test-only loops, and progress

# Source date utilities for cross-platform compatibility
source "$(dirname "${BASH_SOURCE[0]}")/date_utils.sh"

# Response Analysis Functions
# Based on expert recommendations from Martin Fowler, Michael Nygard, Sam Newman

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Use RALPH_DIR if set by main script, otherwise default to .ralph
RALPH_DIR="${RALPH_DIR:-.ralph}"

# Analysis configuration
COMPLETION_KEYWORDS=("done" "complete" "finished" "all tasks complete" "project complete" "ready for review")
TEST_ONLY_PATTERNS=("npm test" "bats" "pytest" "jest" "cargo test" "go test" "running tests")
NO_WORK_PATTERNS=("nothing to do" "no changes" "already implemented" "up to date")
PERMISSION_DENIAL_INLINE_PATTERNS=(
    "requires approval before it can run"
    "requires approval before it can proceed"
    "not allowed to use tool"
    "not permitted to use tool"
)

extract_permission_signal_text() {
    local text=$1

    if [[ -z "$text" ]]; then
        echo ""
        return 0
    fi

    # Only inspect the response preamble for tool refusals. Later paragraphs and
    # copied logs often contain old permission errors that should not halt Ralph.
    local signal_source="${text//$'\r'/}"
    if [[ "$signal_source" == *"---RALPH_STATUS---"* ]]; then
        signal_source="${signal_source%%---RALPH_STATUS---*}"
    fi

    local signal_text=""
    local non_empty_lines=0
    local trimmed=""
    local line=""

    while IFS= read -r line; do
        trimmed="${line#"${line%%[![:space:]]*}"}"
        trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"

        if [[ -z "$trimmed" ]]; then
            if [[ $non_empty_lines -gt 0 ]]; then
                break
            fi
            continue
        fi

        signal_text+="$trimmed"$'\n'
        ((non_empty_lines += 1))
        if [[ $non_empty_lines -ge 5 ]]; then
            break
        fi
    done <<< "$signal_source"

    printf '%s' "$signal_text"
}

permission_denial_line_matches() {
    local normalized=$1

    case "$normalized" in
        permission\ denied:*|denied\ permission:*)
            [[ "$normalized" == *approval* || "$normalized" == *tool* || "$normalized" == *command* || "$normalized" == *blocked* || "$normalized" == *"not allowed"* || "$normalized" == *"not permitted"* ]]
            return
            ;;
        approval\ required:*)
            [[ "$normalized" == *run* || "$normalized" == *proceed* || "$normalized" == *tool* || "$normalized" == *command* || "$normalized" == *blocked* ]]
            return
            ;;
    esac

    return 1
}

contains_permission_denial_signal() {
    local signal_text=$1

    if [[ -z "$signal_text" ]]; then
        return 1
    fi

    local line
    while IFS= read -r line; do
        local trimmed="${line#"${line%%[![:space:]]*}"}"
        local normalized
        normalized="$(printf '%s' "$trimmed" | tr '[:upper:]' '[:lower:]')"

        if permission_denial_line_matches "$normalized"; then
            return 0
        fi

        local pattern
        for pattern in "${PERMISSION_DENIAL_INLINE_PATTERNS[@]}"; do
            if [[ "$normalized" == *"$pattern"* ]]; then
                return 0
            fi
        done
    done <<< "$signal_text"

    return 1
}

contains_permission_denial_text() {
    local signal_text
    signal_text=$(extract_permission_signal_text "$1")
    contains_permission_denial_signal "$signal_text"
}

# =============================================================================
# JSON OUTPUT FORMAT DETECTION AND PARSING
# =============================================================================

# Windows jq.exe handles workspace-relative paths more reliably than POSIX
# absolute temp paths like /tmp/... when invoked from Git Bash.
create_jq_temp_file() {
    mktemp "./.response_analyzer.XXXXXX"
}

# Count parseable top-level JSON documents in an output file.
count_json_documents() {
    local output_file=$1

    if [[ ! -f "$output_file" ]] || [[ ! -s "$output_file" ]]; then
        echo "0"
        return 1
    fi

    jq -n -j 'reduce inputs as $item (0; . + 1)' < "$output_file" 2>/dev/null
}

# Normalize a Claude CLI array response into a single object file.
normalize_cli_array_response() {
    local output_file=$1
    local normalized_file=$2

    # Extract the "result" type message from the array (usually the last entry)
    # This contains: result, session_id, is_error, duration_ms, etc.
    local result_obj=$(jq '[.[] | select(.type == "result")] | .[-1] // {}' "$output_file" 2>/dev/null)

    # Guard against empty result_obj if jq fails (review fix: Macroscope)
    [[ -z "$result_obj" ]] && result_obj="{}"

    # Extract session_id from init message as fallback
    local init_session_id=$(jq -r '.[] | select(.type == "system" and .subtype == "init") | .session_id // empty' "$output_file" 2>/dev/null | head -1 | tr -d '\r')

    # Prioritize result object's own session_id, then fall back to init message (review fix: CodeRabbit)
    # This prevents session ID loss when arrays lack an init message with session_id
    local effective_session_id
    effective_session_id=$(echo "$result_obj" | jq -r -j '.sessionId // .session_id // empty' 2>/dev/null)
    if [[ -z "$effective_session_id" || "$effective_session_id" == "null" ]]; then
        effective_session_id="$init_session_id"
    fi

    # Build normalized object merging result with effective session_id
    if [[ -n "$effective_session_id" && "$effective_session_id" != "null" ]]; then
        echo "$result_obj" | jq --arg sid "$effective_session_id" '. + {sessionId: $sid} | del(.session_id)' > "$normalized_file"
    else
        echo "$result_obj" | jq 'del(.session_id)' > "$normalized_file"
    fi
}

# Normalize Codex JSONL event output into the object shape expected downstream.
normalize_codex_jsonl_response() {
    local output_file=$1
    local normalized_file=$2

    jq -rs '
        def agent_text($item):
            $item.text // (
                [($item.content // [])[]? | select(.type == "output_text") | .text]
                | join("\n")
            ) // "";

        (map(select(.type == "item.completed" and .item.type == "agent_message")) | last | .item // {}) as $agent_message
        | {
            result: agent_text($agent_message),
            sessionId: (map(select(.type == "thread.started") | .thread_id // empty) | first // ""),
            metadata: {}
        }
    ' "$output_file" > "$normalized_file"
}

# Normalize Cursor stream-json event output into the object shape expected downstream.
normalize_cursor_stream_json_response() {
    local output_file=$1
    local normalized_file=$2

    jq -rs '
        def assistant_text($item):
            [($item.message.content // [])[]? | select(.type == "text") | .text]
            | join("\n");

        (map(select(.type == "result")) | last // {}) as $result_event
        | {
            result: (
                $result_event.result
                // (
                    map(select(.type == "assistant"))
                    | map(assistant_text(.))
                    | map(select(length > 0))
                    | join("\n")
                )
            ),
            sessionId: (
                $result_event.session_id
                // (map(select(.type == "system" and .subtype == "init") | .session_id // empty) | first)
                // ""
            ),
            metadata: {}
        }
    ' "$output_file" > "$normalized_file"
}

# Normalize OpenCode JSON event output into the object shape expected downstream.
normalize_opencode_jsonl_response() {
    local output_file=$1
    local normalized_file=$2

    jq -rs '
        def assistant_text($message):
            [($message.parts // [])[]? | select(.type == "text") | .text]
            | join("\n");

        (map(
            select(
                (.type == "message.updated" or .type == "message.completed")
                and (.message.role // "") == "assistant"
            )
        ) | last | .message // {}) as $assistant_message
        | {
            result: assistant_text($assistant_message),
            sessionId: (
                map(.session.id // .session_id // .sessionId // empty)
                | map(select(length > 0))
                | first
                // ""
            ),
            metadata: {}
        }
    ' "$output_file" > "$normalized_file"
}

# Detect whether a multi-document stream matches Codex JSONL events.
is_codex_jsonl_output() {
    local output_file=$1

    jq -n -j '
        reduce inputs as $item (
            false;
            . or (
                $item.type == "thread.started" or
                ($item.type == "item.completed" and ($item.item.type? != null))
            )
        )
    ' < "$output_file" 2>/dev/null
}

# Detect whether a multi-document stream matches OpenCode JSON events.
is_opencode_jsonl_output() {
    local output_file=$1

    jq -n -j '
        reduce inputs as $item (
            false;
            . or (
                $item.type == "session.created" or
                $item.type == "session.updated" or
                (
                    ($item.type == "message.updated" or $item.type == "message.completed")
                    and ($item.message.role? != null)
                )
            )
        )
    ' < "$output_file" 2>/dev/null
}

# Detect whether a multi-document stream matches Cursor stream-json events.
is_cursor_stream_json_output() {
    local output_file=$1

    jq -n -j '
        reduce inputs as $item (
            false;
            . or (
                $item.type == "system" or
                $item.type == "user" or
                $item.type == "assistant" or
                $item.type == "tool_call" or
                $item.type == "result"
            )
        )
    ' < "$output_file" 2>/dev/null
}

# Normalize structured output to a single object when downstream parsing expects one.
normalize_json_output() {
    local output_file=$1
    local normalized_file=$2
    local json_document_count

    json_document_count=$(count_json_documents "$output_file") || return 1

    if [[ "$json_document_count" -gt 1 ]]; then
        local is_codex_jsonl
        is_codex_jsonl=$(is_codex_jsonl_output "$output_file") || return 1

        if [[ "$is_codex_jsonl" == "true" ]]; then
            normalize_codex_jsonl_response "$output_file" "$normalized_file"
            return $?
        fi

        local is_opencode_jsonl
        is_opencode_jsonl=$(is_opencode_jsonl_output "$output_file") || return 1

        if [[ "$is_opencode_jsonl" == "true" ]]; then
            normalize_opencode_jsonl_response "$output_file" "$normalized_file"
            return $?
        fi

        local is_cursor_stream_json
        is_cursor_stream_json=$(is_cursor_stream_json_output "$output_file") || return 1

        if [[ "$is_cursor_stream_json" == "true" ]]; then
            normalize_cursor_stream_json_response "$output_file" "$normalized_file"
            return $?
        fi

        return 1
    fi

    if jq -e 'type == "array"' "$output_file" >/dev/null 2>&1; then
        normalize_cli_array_response "$output_file" "$normalized_file"
        return $?
    fi

    return 1
}

# Extract persisted session ID from any supported structured output.
extract_session_id_from_output() {
    local output_file=$1
    local normalized_file=""
    local session_id=""
    local json_document_count

    if [[ ! -f "$output_file" ]] || [[ ! -s "$output_file" ]]; then
        echo ""
        return 1
    fi

    json_document_count=$(count_json_documents "$output_file") || {
        echo ""
        return 1
    }

    if [[ "$json_document_count" -gt 1 ]] || jq -e 'type == "array"' "$output_file" >/dev/null 2>&1; then
        normalized_file=$(create_jq_temp_file)
        if ! normalize_json_output "$output_file" "$normalized_file"; then
            rm -f "$normalized_file"
            echo ""
            return 1
        fi
        output_file="$normalized_file"
    fi

    session_id=$(jq -r '.sessionId // .metadata.session_id // .session_id // empty' "$output_file" 2>/dev/null | head -1 | tr -d '\r')

    if [[ -n "$normalized_file" && -f "$normalized_file" ]]; then
        rm -f "$normalized_file"
    fi

    echo "$session_id"
    [[ -n "$session_id" && "$session_id" != "null" ]]
}

# Detect output format (json or text)
# Returns: "json" for single-document JSON and newline-delimited JSON, "text" otherwise
detect_output_format() {
    local output_file=$1

    if [[ ! -f "$output_file" ]] || [[ ! -s "$output_file" ]]; then
        echo "text"
        return
    fi

    # Check if file starts with { or [ (JSON indicators)
    local first_char=$(head -c 1 "$output_file" 2>/dev/null | tr -d '[:space:]')

    if [[ "$first_char" != "{" && "$first_char" != "[" ]]; then
        echo "text"
        return
    fi

    local json_document_count
    json_document_count=$(count_json_documents "$output_file") || {
        echo "text"
        return
    }

    if [[ "$json_document_count" -eq 1 ]]; then
        echo "json"
        return
    fi

    if [[ "$json_document_count" -gt 1 ]]; then
        local is_codex_jsonl
        is_codex_jsonl=$(is_codex_jsonl_output "$output_file") || {
            echo "text"
            return
        }

        if [[ "$is_codex_jsonl" == "true" ]]; then
            echo "json"
            return
        fi

        local is_opencode_jsonl
        is_opencode_jsonl=$(is_opencode_jsonl_output "$output_file") || {
            echo "text"
            return
        }

        if [[ "$is_opencode_jsonl" == "true" ]]; then
            echo "json"
            return
        fi

        local is_cursor_stream_json
        is_cursor_stream_json=$(is_cursor_stream_json_output "$output_file") || {
            echo "text"
            return
        }

        if [[ "$is_cursor_stream_json" == "true" ]]; then
            echo "json"
            return
        fi
    fi

    echo "text"
}

trim_shell_whitespace() {
    local value="${1//$'\r'/}"

    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"

    printf '%s' "$value"
}

extract_ralph_status_block_json() {
    local text=$1
    local normalized="${text//$'\r'/}"

    if [[ "$normalized" != *"---RALPH_STATUS---"* ]]; then
        return 1
    fi

    local block="${normalized#*---RALPH_STATUS---}"
    if [[ "$block" == "$normalized" ]]; then
        return 1
    fi

    if [[ "$block" == *"---END_RALPH_STATUS---"* ]]; then
        block="${block%%---END_RALPH_STATUS---*}"
    fi

    local status=""
    local exit_signal="false"
    local exit_signal_found="false"
    local tasks_completed_this_loop=0
    local tests_status="UNKNOWN"
    local line=""
    local trimmed=""
    local value=""

    while IFS= read -r line; do
        trimmed=$(trim_shell_whitespace "$line")

        case "$trimmed" in
            STATUS:*)
                value=$(trim_shell_whitespace "${trimmed#STATUS:}")
                [[ -n "$value" ]] && status="$value"
                ;;
            EXIT_SIGNAL:*)
                value=$(trim_shell_whitespace "${trimmed#EXIT_SIGNAL:}")
                if [[ "$value" == "true" || "$value" == "false" ]]; then
                    exit_signal="$value"
                    exit_signal_found="true"
                fi
                ;;
            TASKS_COMPLETED_THIS_LOOP:*)
                value=$(trim_shell_whitespace "${trimmed#TASKS_COMPLETED_THIS_LOOP:}")
                if [[ "$value" =~ ^-?[0-9]+$ ]]; then
                    tasks_completed_this_loop=$value
                fi
                ;;
            TESTS_STATUS:*)
                value=$(trim_shell_whitespace "${trimmed#TESTS_STATUS:}")
                [[ -n "$value" ]] && tests_status="$value"
                ;;
        esac
    done <<< "$block"

    jq -n \
        --arg status "$status" \
        --argjson exit_signal_found "$exit_signal_found" \
        --argjson exit_signal "$exit_signal" \
        --argjson tasks_completed_this_loop "$tasks_completed_this_loop" \
        --arg tests_status "$tests_status" \
        '{
            status: $status,
            exit_signal_found: $exit_signal_found,
            exit_signal: $exit_signal,
            tasks_completed_this_loop: $tasks_completed_this_loop,
            tests_status: $tests_status
        }'
}

# Parse JSON response and extract structured fields
# Creates .ralph/.json_parse_result with normalized analysis data
# Supports SIX JSON formats:
# 1. Flat format: { status, exit_signal, work_type, files_modified, ... }
# 2. Claude CLI object format: { result, sessionId, metadata: { files_changed, has_errors, completion_status, ... } }
# 3. Claude CLI array format: [ {type: "system", ...}, {type: "assistant", ...}, {type: "result", ...} ]
# 4. Codex JSONL format: {"type":"thread.started",...}\n{"type":"item.completed","item":{...}}
# 5. OpenCode JSON event format: {"type":"session.created",...}\n{"type":"message.updated",...}
# 6. Cursor stream-json format: {"type":"assistant",...}\n{"type":"result",...}
parse_json_response() {
    local output_file=$1
    local result_file="${2:-$RALPH_DIR/.json_parse_result}"
    local original_output_file=$output_file
    local normalized_file=""
    local json_document_count=""
    local response_shape="object"

    if [[ ! -f "$output_file" ]]; then
        echo "ERROR: Output file not found: $output_file" >&2
        return 1
    fi

    # Validate JSON first
    json_document_count=$(count_json_documents "$output_file") || {
        echo "ERROR: Invalid JSON in output file" >&2
        return 1
    }

    # Normalize multi-document JSONL and array responses to a single object.
    if [[ "$json_document_count" -gt 1 ]] || jq -e 'type == "array"' "$output_file" >/dev/null 2>&1; then
        if [[ "$json_document_count" -gt 1 ]]; then
            response_shape="jsonl"
        else
            response_shape="array"
        fi
        normalized_file=$(create_jq_temp_file)
        if ! normalize_json_output "$output_file" "$normalized_file"; then
            rm -f "$normalized_file"
            echo "ERROR: Failed to normalize JSON output" >&2
            return 1
        fi

        # Use normalized file for subsequent parsing
        output_file="$normalized_file"

        if [[ "$response_shape" == "jsonl" ]]; then
            if [[ "$(is_codex_jsonl_output "$original_output_file")" == "true" ]]; then
                response_shape="codex_jsonl"
            elif [[ "$(is_opencode_jsonl_output "$original_output_file")" == "true" ]]; then
                response_shape="opencode_jsonl"
            else
                response_shape="cursor_stream_jsonl"
            fi
        fi
    fi

    local has_result_field="false"
    local status="UNKNOWN"
    local completion_status=""
    local exit_signal="false"
    local explicit_exit_signal_found="false"
    local tasks_completed_this_loop=0
    local tests_status="UNKNOWN"
    local result_text=""
    local work_type="UNKNOWN"
    local files_modified=0
    local error_count=0
    local has_errors="false"
    local summary=""
    local session_id=""
    local loop_number=0
    local confidence=0
    local progress_count=0
    local permission_denial_count=0
    local has_permission_denials="false"
    local denied_commands_json="[]"

    if [[ "$response_shape" == "codex_jsonl" || "$response_shape" == "opencode_jsonl" || "$response_shape" == "cursor_stream_jsonl" ]]; then
        local driver_fields=""
        driver_fields=$(jq -r '
            [
                (.result // ""),
                (.sessionId // .metadata.session_id // .session_id // ""),
                ((.permission_denials // []) | length),
                ((.permission_denials // []) | map(
                    if .tool_name == "Bash" then
                        "Bash(\(.tool_input.command // "?" | split("\n")[0] | .[0:60]))"
                    else
                        .tool_name // "unknown"
                    end
                ) | @json)
            ] | @tsv
        ' "$output_file" 2>/dev/null)

        local denied_commands_field="[]"
        IFS=$'\t' read -r result_text session_id permission_denial_count denied_commands_field <<< "$driver_fields"

        has_result_field="true"
        summary="$result_text"
        denied_commands_json="${denied_commands_field:-[]}"

        if [[ ! "$permission_denial_count" =~ ^-?[0-9]+$ ]]; then
            permission_denial_count=0
        fi

        if [[ $permission_denial_count -gt 0 ]]; then
            has_permission_denials="true"
        fi
    else
        # Detect JSON format by checking for Claude CLI fields
        has_result_field=$(jq -r -j 'has("result")' "$output_file" 2>/dev/null)

        # Extract fields - support both flat format and Claude CLI format
        # Priority: Claude CLI fields first, then flat format fields

        # Status: from flat format OR derived from metadata.completion_status
        status=$(jq -r -j '.status // "UNKNOWN"' "$output_file" 2>/dev/null)
        completion_status=$(jq -r -j '.metadata.completion_status // ""' "$output_file" 2>/dev/null)
        if [[ "$completion_status" == "complete" || "$completion_status" == "COMPLETE" ]]; then
            status="COMPLETE"
        fi

        # Exit signal: from flat format OR derived from completion_status
        # Track whether EXIT_SIGNAL was explicitly provided (vs inferred from STATUS)
        exit_signal=$(jq -r -j '.exit_signal // false' "$output_file" 2>/dev/null)
        explicit_exit_signal_found=$(jq -r -j 'has("exit_signal")' "$output_file" 2>/dev/null)
        tasks_completed_this_loop=$(jq -r -j '.tasks_completed_this_loop // 0' "$output_file" 2>/dev/null)
        if [[ ! "$tasks_completed_this_loop" =~ ^-?[0-9]+$ ]]; then
            tasks_completed_this_loop=0
        fi

        if [[ "$has_result_field" == "true" ]]; then
            result_text=$(jq -r -j '.result // ""' "$output_file" 2>/dev/null)
        fi

        # Work type: from flat format
        work_type=$(jq -r -j '.work_type // "UNKNOWN"' "$output_file" 2>/dev/null)

        # Files modified: from flat format OR from metadata.files_changed
        files_modified=$(jq -r -j '.metadata.files_changed // .files_modified // 0' "$output_file" 2>/dev/null)

        # Error count: from flat format OR derived from metadata.has_errors
        # Note: When only has_errors=true is present (without explicit error_count),
        # we set error_count=1 as a minimum. This is defensive programming since
        # the stuck detection threshold is >5 errors, so 1 error won't trigger it.
        # Actual error count may be higher, but precise count isn't critical for our logic.
        error_count=$(jq -r -j '.error_count // 0' "$output_file" 2>/dev/null)
        has_errors=$(jq -r -j '.metadata.has_errors // false' "$output_file" 2>/dev/null)
        if [[ "$has_errors" == "true" && "$error_count" == "0" ]]; then
            error_count=1  # At least one error if has_errors is true
        fi

        # Summary: from flat format OR from result field (Claude CLI format)
        summary=$(jq -r -j '.result // .summary // ""' "$output_file" 2>/dev/null)

        # Session ID: from Claude CLI format (sessionId) OR from metadata.session_id
        session_id=$(jq -r -j '.sessionId // .metadata.session_id // .session_id // ""' "$output_file" 2>/dev/null)

        # Loop number: from metadata
        loop_number=$(jq -r -j '.metadata.loop_number // .loop_number // 0' "$output_file" 2>/dev/null)

        # Confidence: from flat format
        confidence=$(jq -r -j '.confidence // 0' "$output_file" 2>/dev/null)

        # Progress indicators: from Claude CLI metadata (optional)
        progress_count=$(jq -r -j '.metadata.progress_indicators | if . then length else 0 end' "$output_file" 2>/dev/null)

        # Permission denials: from Claude Code output (Issue #101)
        # When Claude Code is denied permission to run commands, it outputs a permission_denials array
        permission_denial_count=$(jq -r -j '.permission_denials | if . then length else 0 end' "$output_file" 2>/dev/null)
        permission_denial_count=$((permission_denial_count + 0))  # Ensure integer

        if [[ $permission_denial_count -gt 0 ]]; then
            has_permission_denials="true"
        fi

        # Extract denied tool names and commands for logging/display
        # Shows tool_name for non-Bash tools, and for Bash tools shows the command that was denied
        # This handles both cases: AskUserQuestion denial shows "AskUserQuestion",
        # while Bash denial shows "Bash(git commit -m ...)" with truncated command
        if [[ $permission_denial_count -gt 0 ]]; then
            denied_commands_json=$(jq -r -j '[.permission_denials[] | if .tool_name == "Bash" then "Bash(\(.tool_input.command // "?" | split("\n")[0] | .[0:60]))" else .tool_name // "unknown" end]' "$output_file" 2>/dev/null || echo "[]")
        fi
    fi

    local ralph_status_json=""
    if [[ -n "$result_text" ]] && ralph_status_json=$(extract_ralph_status_block_json "$result_text" 2>/dev/null); then
        local embedded_exit_signal_found
        embedded_exit_signal_found=$(printf '%s' "$ralph_status_json" | jq -r -j '.exit_signal_found' 2>/dev/null)
        local embedded_exit_sig
        embedded_exit_sig=$(printf '%s' "$ralph_status_json" | jq -r -j '.exit_signal' 2>/dev/null)
        local embedded_status
        embedded_status=$(printf '%s' "$ralph_status_json" | jq -r -j '.status' 2>/dev/null)
        local embedded_tasks_completed
        embedded_tasks_completed=$(printf '%s' "$ralph_status_json" | jq -r -j '.tasks_completed_this_loop' 2>/dev/null)
        local embedded_tests_status
        embedded_tests_status=$(printf '%s' "$ralph_status_json" | jq -r -j '.tests_status' 2>/dev/null)

        if [[ "$embedded_tasks_completed" =~ ^-?[0-9]+$ ]]; then
            tasks_completed_this_loop=$embedded_tasks_completed
        fi
        if [[ -n "$embedded_tests_status" && "$embedded_tests_status" != "null" ]]; then
            tests_status="$embedded_tests_status"
        fi

        if [[ "$embedded_exit_signal_found" == "true" ]]; then
            explicit_exit_signal_found="true"
            exit_signal="$embedded_exit_sig"
            [[ "${VERBOSE_PROGRESS:-}" == "true" ]] && echo "DEBUG: Extracted EXIT_SIGNAL=$embedded_exit_sig from .result RALPH_STATUS block" >&2
        elif [[ "$embedded_status" == "COMPLETE" && "$explicit_exit_signal_found" != "true" ]]; then
            exit_signal="true"
            [[ "${VERBOSE_PROGRESS:-}" == "true" ]] && echo "DEBUG: Inferred EXIT_SIGNAL=true from .result STATUS=COMPLETE (no explicit EXIT_SIGNAL found)" >&2
        fi
    fi

    # Heuristic permission-denial matching is limited to the refusal-shaped
    # response preamble, not arbitrary prose or copied logs later in the body.
    if [[ "$has_permission_denials" != "true" ]] && contains_permission_denial_text "$summary"; then
        has_permission_denials="true"
        permission_denial_count=1
        denied_commands_json='["permission_denied"]'
    fi

    # Apply completion heuristics to normalized summary text when explicit structured
    # completion markers are absent. This keeps JSONL analysis aligned with text mode.
    local summary_has_completion_keyword="false"
    local summary_has_no_work_pattern="false"
    if [[ "$response_shape" == "codex_jsonl" || "$response_shape" == "opencode_jsonl" || "$response_shape" == "cursor_stream_jsonl" ]] && [[ "$explicit_exit_signal_found" != "true" && -n "$summary" ]]; then
        for keyword in "${COMPLETION_KEYWORDS[@]}"; do
            if echo "$summary" | grep -qiw "$keyword"; then
                summary_has_completion_keyword="true"
                break
            fi
        done

        for pattern in "${NO_WORK_PATTERNS[@]}"; do
            if echo "$summary" | grep -qiw "$pattern"; then
                summary_has_no_work_pattern="true"
                break
            fi
        done
    fi

    # Normalize values
    # Convert exit_signal to boolean string
    # Only infer from status/completion_status if no explicit EXIT_SIGNAL was provided
    if [[ "$explicit_exit_signal_found" == "true" ]]; then
        # Respect explicit EXIT_SIGNAL value (already set above)
        [[ "$exit_signal" == "true" ]] && exit_signal="true" || exit_signal="false"
    elif [[ "$exit_signal" == "true" || "$status" == "COMPLETE" || "$completion_status" == "complete" || "$completion_status" == "COMPLETE" || "$summary_has_completion_keyword" == "true" || "$summary_has_no_work_pattern" == "true" ]]; then
        exit_signal="true"
    else
        exit_signal="false"
    fi

    # Determine is_test_only from work_type
    local is_test_only="false"
    if [[ "$work_type" == "TEST_ONLY" ]]; then
        is_test_only="true"
    fi

    # Determine is_stuck from error_count (threshold >5)
    local is_stuck="false"
    error_count=$((error_count + 0))  # Ensure integer
    if [[ $error_count -gt 5 ]]; then
        is_stuck="true"
    fi

    # Ensure files_modified is integer
    files_modified=$((files_modified + 0))

    # Ensure progress_count is integer
    progress_count=$((progress_count + 0))

    # Calculate has_completion_signal
    local has_completion_signal="false"
    if [[ "$explicit_exit_signal_found" == "true" ]]; then
        if [[ "$exit_signal" == "true" ]]; then
            has_completion_signal="true"
        fi
    elif [[ "$status" == "COMPLETE" || "$exit_signal" == "true" || "$summary_has_completion_keyword" == "true" || "$summary_has_no_work_pattern" == "true" ]]; then
        has_completion_signal="true"
    fi

    # Write normalized result using jq for safe JSON construction
    # String fields use --arg (auto-escapes), numeric/boolean use --argjson
    jq -n \
        --arg status "$status" \
        --argjson exit_signal "$exit_signal" \
        --argjson is_test_only "$is_test_only" \
        --argjson is_stuck "$is_stuck" \
        --argjson has_completion_signal "$has_completion_signal" \
        --argjson files_modified "$files_modified" \
        --argjson error_count "$error_count" \
        --arg summary "$summary" \
        --argjson loop_number "$loop_number" \
        --arg session_id "$session_id" \
        --argjson confidence "$confidence" \
        --argjson tasks_completed_this_loop "$tasks_completed_this_loop" \
        --argjson has_permission_denials "$has_permission_denials" \
        --argjson permission_denial_count "$permission_denial_count" \
        --argjson denied_commands "$denied_commands_json" \
        --arg tests_status "$tests_status" \
        --argjson has_result_field "$has_result_field" \
        '{
            status: $status,
            exit_signal: $exit_signal,
            is_test_only: $is_test_only,
            is_stuck: $is_stuck,
            has_completion_signal: $has_completion_signal,
            has_result_field: $has_result_field,
            files_modified: $files_modified,
            error_count: $error_count,
            summary: $summary,
            loop_number: $loop_number,
            session_id: $session_id,
            confidence: $confidence,
            tasks_completed_this_loop: $tasks_completed_this_loop,
            tests_status: $tests_status,
            has_permission_denials: $has_permission_denials,
            permission_denial_count: $permission_denial_count,
            denied_commands: $denied_commands,
            metadata: {
                loop_number: $loop_number,
                session_id: $session_id
            }
        }' > "$result_file"

    # Cleanup temporary normalized file if created (for array format handling)
    if [[ -n "$normalized_file" && -f "$normalized_file" ]]; then
        rm -f "$normalized_file"
    fi

    return 0
}

# Analyze Claude Code response and extract signals
analyze_response() {
    local output_file=$1
    local loop_number=$2
    local analysis_result_file=${3:-"$RALPH_DIR/.response_analysis"}

    # Initialize analysis result
    local has_completion_signal=false
    local is_test_only=false
    local is_stuck=false
    local has_progress=false
    local confidence_score=0
    local exit_signal=false
    local format_confidence=0
    local work_summary=""
    local files_modified=0
    local tasks_completed_this_loop=0
    local tests_status="UNKNOWN"

    # Read output file
    if [[ ! -f "$output_file" ]]; then
        echo "ERROR: Output file not found: $output_file"
        return 1
    fi

    local output_content=$(cat "$output_file")
    local output_length=${#output_content}

    # Detect output format and try JSON parsing first
    local output_format=$(detect_output_format "$output_file")
    local json_parse_result_file=""

    if [[ "$output_format" == "json" ]]; then
        # Try JSON parsing
        json_parse_result_file=$(create_jq_temp_file)
        if parse_json_response "$output_file" "$json_parse_result_file" 2>/dev/null; then
            # Extract values from JSON parse result
            has_completion_signal=$(jq -r -j '.has_completion_signal' "$json_parse_result_file" 2>/dev/null || echo "false")
            exit_signal=$(jq -r -j '.exit_signal' "$json_parse_result_file" 2>/dev/null || echo "false")
            is_test_only=$(jq -r -j '.is_test_only' "$json_parse_result_file" 2>/dev/null || echo "false")
            is_stuck=$(jq -r -j '.is_stuck' "$json_parse_result_file" 2>/dev/null || echo "false")
            work_summary=$(jq -r -j '.summary' "$json_parse_result_file" 2>/dev/null || echo "")
            files_modified=$(jq -r -j '.files_modified' "$json_parse_result_file" 2>/dev/null || echo "0")
            tasks_completed_this_loop=$(jq -r -j '.tasks_completed_this_loop // 0' "$json_parse_result_file" 2>/dev/null || echo "0")
            tests_status=$(jq -r -j '.tests_status // "UNKNOWN"' "$json_parse_result_file" 2>/dev/null || echo "UNKNOWN")
            local json_confidence=$(jq -r -j '.confidence' "$json_parse_result_file" 2>/dev/null || echo "0")
            local json_has_result_field=$(jq -r -j '.has_result_field' "$json_parse_result_file" 2>/dev/null || echo "false")
            local session_id=$(jq -r -j '.session_id' "$json_parse_result_file" 2>/dev/null || echo "")

            # Extract permission denial fields (Issue #101)
            local has_permission_denials=$(jq -r -j '.has_permission_denials' "$json_parse_result_file" 2>/dev/null || echo "false")
            local permission_denial_count=$(jq -r -j '.permission_denial_count' "$json_parse_result_file" 2>/dev/null || echo "0")
            local denied_commands_json=$(jq -r -j '.denied_commands' "$json_parse_result_file" 2>/dev/null || echo "[]")

            # Persist session ID if present (for session continuity across loop iterations)
            if [[ -n "$session_id" && "$session_id" != "null" ]]; then
                store_session_id "$session_id"
                [[ "${VERBOSE_PROGRESS:-}" == "true" ]] && echo "DEBUG: Persisted session ID: $session_id" >&2
            fi

            # Separate format confidence from completion confidence (Issue #124)
            if [[ "$json_has_result_field" == "true" ]]; then
                format_confidence=100
            else
                format_confidence=80
            fi
            if [[ "$exit_signal" == "true" ]]; then
                confidence_score=100
            else
                confidence_score=$json_confidence
            fi

            if [[ ! "$tasks_completed_this_loop" =~ ^-?[0-9]+$ ]]; then
                tasks_completed_this_loop=0
            fi

            # Check for file changes via git (supplements JSON data)
            # Fix #141: Detect both uncommitted changes AND committed changes
            if command -v git &>/dev/null && git rev-parse --git-dir >/dev/null 2>&1; then
                local git_files=0
                local loop_start_sha=""
                local current_sha=""

                if [[ -f "$RALPH_DIR/.loop_start_sha" ]]; then
                    loop_start_sha=$(cat "$RALPH_DIR/.loop_start_sha" 2>/dev/null || echo "")
                fi
                current_sha=$(git rev-parse HEAD 2>/dev/null || echo "")

                # Check if commits were made (HEAD changed)
                if [[ -n "$loop_start_sha" && -n "$current_sha" && "$loop_start_sha" != "$current_sha" ]]; then
                    # Commits were made - count union of committed files AND working tree changes
                    git_files=$(
                        {
                            git diff --name-only "$loop_start_sha" "$current_sha" 2>/dev/null
                            git diff --name-only HEAD 2>/dev/null           # unstaged changes
                            git diff --name-only --cached 2>/dev/null       # staged changes
                        } | sort -u | wc -l
                    )
                else
                    # No commits - check for uncommitted changes (staged + unstaged)
                    git_files=$(
                        {
                            git diff --name-only 2>/dev/null                # unstaged changes
                            git diff --name-only --cached 2>/dev/null       # staged changes
                        } | sort -u | wc -l
                    )
                fi

                if [[ $git_files -gt 0 ]]; then
                    has_progress=true
                    files_modified=$git_files
                fi
            fi

            # Write analysis results for JSON path using jq for safe construction
            jq -n \
                --argjson loop_number "$loop_number" \
                --arg timestamp "$(get_iso_timestamp)" \
                --arg output_file "$output_file" \
                --arg output_format "json" \
                --argjson has_completion_signal "$has_completion_signal" \
                --argjson is_test_only "$is_test_only" \
                --argjson is_stuck "$is_stuck" \
                --argjson has_progress "$has_progress" \
                --argjson files_modified "$files_modified" \
                --argjson format_confidence "$format_confidence" \
                --argjson confidence_score "$confidence_score" \
                --argjson exit_signal "$exit_signal" \
                --argjson tasks_completed_this_loop "$tasks_completed_this_loop" \
                --arg work_summary "$work_summary" \
                --argjson output_length "$output_length" \
                --argjson has_permission_denials "$has_permission_denials" \
                --argjson permission_denial_count "$permission_denial_count" \
                --argjson denied_commands "$denied_commands_json" \
                --arg tests_status "$tests_status" \
                '{
                    loop_number: $loop_number,
                    timestamp: $timestamp,
                    output_file: $output_file,
                    output_format: $output_format,
                    analysis: {
                        has_completion_signal: $has_completion_signal,
                        is_test_only: $is_test_only,
                        is_stuck: $is_stuck,
                        has_progress: $has_progress,
                        files_modified: $files_modified,
                        format_confidence: $format_confidence,
                        confidence_score: $confidence_score,
                        exit_signal: $exit_signal,
                        tasks_completed_this_loop: $tasks_completed_this_loop,
                        tests_status: $tests_status,
                        fix_plan_completed_delta: 0,
                        has_progress_tracking_mismatch: false,
                        work_summary: $work_summary,
                        output_length: $output_length,
                        has_permission_denials: $has_permission_denials,
                        permission_denial_count: $permission_denial_count,
                        denied_commands: $denied_commands
                    }
                }' > "$analysis_result_file"
            rm -f "$json_parse_result_file"
            return 0
        fi
        rm -f "$json_parse_result_file"
        # If JSON parsing failed, fall through to text parsing
    fi

    # Text parsing fallback (original logic)

    # 1. Check for explicit structured output (RALPH_STATUS block)
    # When a status block is present, it is authoritative — skip all heuristics.
    # A structurally valid but field-empty block results in exit_signal=false,
    # confidence=0 by design (AI produced a block but provided no signal).
    local ralph_status_block_found=false
    local ralph_status_json=""
    if ralph_status_json=$(extract_ralph_status_block_json "$output_content" 2>/dev/null); then
        ralph_status_block_found=true
        format_confidence=70

        local status
        status=$(printf '%s' "$ralph_status_json" | jq -r -j '.status' 2>/dev/null)
        local exit_sig_found
        exit_sig_found=$(printf '%s' "$ralph_status_json" | jq -r -j '.exit_signal_found' 2>/dev/null)
        local exit_sig
        exit_sig=$(printf '%s' "$ralph_status_json" | jq -r -j '.exit_signal' 2>/dev/null)
        local parsed_tasks_completed
        parsed_tasks_completed=$(printf '%s' "$ralph_status_json" | jq -r -j '.tasks_completed_this_loop' 2>/dev/null)
        local parsed_tests_status
        parsed_tests_status=$(printf '%s' "$ralph_status_json" | jq -r -j '.tests_status' 2>/dev/null)

        if [[ "$parsed_tasks_completed" =~ ^-?[0-9]+$ ]]; then
            tasks_completed_this_loop=$parsed_tasks_completed
        fi
        if [[ -n "$parsed_tests_status" && "$parsed_tests_status" != "null" ]]; then
            tests_status="$parsed_tests_status"
        fi

        # If EXIT_SIGNAL is explicitly provided, respect it
        if [[ "$exit_sig_found" == "true" ]]; then
            if [[ "$exit_sig" == "true" ]]; then
                has_completion_signal=true
                exit_signal=true
                confidence_score=100
            else
                # Explicit EXIT_SIGNAL: false — Claude says to continue
                exit_signal=false
                confidence_score=80
            fi
        elif [[ "$status" == "COMPLETE" ]]; then
            # No explicit EXIT_SIGNAL but STATUS is COMPLETE
            has_completion_signal=true
            exit_signal=true
            confidence_score=100
        fi
        # is_test_only and is_stuck stay false (defaults) — status block is authoritative
    fi

    if [[ "$ralph_status_block_found" != "true" ]]; then
        # No status block found — fall back to heuristic analysis
        format_confidence=30

        # 2. Detect completion keywords in natural language output
        for keyword in "${COMPLETION_KEYWORDS[@]}"; do
            if grep -qiw "$keyword" "$output_file"; then
                has_completion_signal=true
                ((confidence_score+=10))
                break
            fi
        done

        # 3. Detect test-only loops
        local test_command_count=0
        local implementation_count=0
        local error_count=0

        test_command_count=$(grep -c -i "running tests\|npm test\|bats\|pytest\|jest" "$output_file" 2>/dev/null | head -1 || echo "0")
        implementation_count=$(grep -c -i "implementing\|creating\|writing\|adding\|function\|class" "$output_file" 2>/dev/null | head -1 || echo "0")

        # Strip whitespace and ensure it's a number
        test_command_count=$(echo "$test_command_count" | tr -d '[:space:]')
        implementation_count=$(echo "$implementation_count" | tr -d '[:space:]')

        # Convert to integers with default fallback
        test_command_count=${test_command_count:-0}
        implementation_count=${implementation_count:-0}
        test_command_count=$((test_command_count + 0))
        implementation_count=$((implementation_count + 0))

        if [[ $test_command_count -gt 0 ]] && [[ $implementation_count -eq 0 ]]; then
            is_test_only=true
            work_summary="Test execution only, no implementation"
        fi

        # 4. Detect stuck/error loops
        # Use two-stage filtering to avoid counting JSON field names as errors
        # Stage 1: Filter out JSON field patterns like "is_error": false
        # Stage 2: Count actual error messages in specific contexts
        # Pattern aligned with ralph_loop.sh to ensure consistent behavior
        error_count=$(grep -v '"[^"]*error[^"]*":' "$output_file" 2>/dev/null | \
                      grep -cE '(^Error:|^ERROR:|^error:|\]: error|Link: error|Error occurred|failed with error|[Ee]xception|Fatal|FATAL)' \
                      2>/dev/null || echo "0")
        error_count=$(echo "$error_count" | tr -d '[:space:]')
        error_count=${error_count:-0}
        error_count=$((error_count + 0))

        if [[ $error_count -gt 5 ]]; then
            is_stuck=true
        fi

        # 5. Detect "nothing to do" patterns
        for pattern in "${NO_WORK_PATTERNS[@]}"; do
            if grep -qiw "$pattern" "$output_file"; then
                has_completion_signal=true
                ((confidence_score+=15))
                work_summary="No work remaining"
                break
            fi
        done

        # 7. Analyze output length trends (detect declining engagement)
        if [[ -f "$RALPH_DIR/.last_output_length" ]]; then
            local last_length
            last_length=$(cat "$RALPH_DIR/.last_output_length")
            if [[ "$last_length" -gt 0 ]]; then
                local length_ratio=$((output_length * 100 / last_length))
                if [[ $length_ratio -lt 50 ]]; then
                    # Output is less than 50% of previous - possible completion
                    ((confidence_score+=10))
                fi
            fi
        fi

        # 9. Determine exit signal based on confidence (heuristic)
        if [[ $confidence_score -ge 40 || "$has_completion_signal" == "true" ]]; then
            exit_signal=true
        fi
    fi

    # Always persist output length for next iteration (both paths)
    echo "$output_length" > "$RALPH_DIR/.last_output_length"

    # 6. Check for file changes (git integration) — always runs
    if command -v git &>/dev/null && git rev-parse --git-dir >/dev/null 2>&1; then
        local loop_start_sha=""
        local current_sha=""

        if [[ -f "$RALPH_DIR/.loop_start_sha" ]]; then
            loop_start_sha=$(cat "$RALPH_DIR/.loop_start_sha" 2>/dev/null || echo "")
        fi
        current_sha=$(git rev-parse HEAD 2>/dev/null || echo "")

        # Check if commits were made (HEAD changed)
        if [[ -n "$loop_start_sha" && -n "$current_sha" && "$loop_start_sha" != "$current_sha" ]]; then
            # Commits were made - count union of committed files AND working tree changes
            files_modified=$(
                {
                    git diff --name-only "$loop_start_sha" "$current_sha" 2>/dev/null
                    git diff --name-only HEAD 2>/dev/null           # unstaged changes
                    git diff --name-only --cached 2>/dev/null       # staged changes
                } | sort -u | wc -l
            )
        else
            # No commits - check for uncommitted changes (staged + unstaged)
            files_modified=$(
                {
                    git diff --name-only 2>/dev/null                # unstaged changes
                    git diff --name-only --cached 2>/dev/null       # staged changes
                } | sort -u | wc -l
            )
        fi

        if [[ $files_modified -gt 0 ]]; then
            has_progress=true
            # Only boost completion confidence in heuristic path (Issue #124)
            # RALPH_STATUS block is authoritative — git changes shouldn't inflate it
            if [[ "$ralph_status_block_found" != "true" ]]; then
                ((confidence_score+=20))
            fi
        fi
    fi

    # 8. Extract work summary from output — always runs
    if [[ -z "$work_summary" ]]; then
        # Try to find summary in output
        work_summary=$(grep -i "summary\|completed\|implemented" "$output_file" | head -1 | cut -c 1-100)
        if [[ -z "$work_summary" ]]; then
            work_summary="Output analyzed, no explicit summary found"
        fi
    fi

    local has_permission_denials=false
    local permission_denial_count=0
    local denied_commands_json='[]'
    local permission_signal_text=""
    permission_signal_text=$(extract_permission_signal_text "$output_content")
    if contains_permission_denial_text "$work_summary" || contains_permission_denial_signal "$permission_signal_text"; then
        has_permission_denials=true
        permission_denial_count=1
        denied_commands_json='["permission_denied"]'
    fi

    # Write analysis results to file (text parsing path) using jq for safe construction
    jq -n \
        --argjson loop_number "$loop_number" \
        --arg timestamp "$(get_iso_timestamp)" \
        --arg output_file "$output_file" \
        --arg output_format "text" \
        --argjson has_completion_signal "$has_completion_signal" \
        --argjson is_test_only "$is_test_only" \
        --argjson is_stuck "$is_stuck" \
        --argjson has_progress "$has_progress" \
        --argjson files_modified "$files_modified" \
        --argjson format_confidence "$format_confidence" \
        --argjson confidence_score "$confidence_score" \
        --argjson exit_signal "$exit_signal" \
        --argjson tasks_completed_this_loop "$tasks_completed_this_loop" \
        --arg work_summary "$work_summary" \
        --argjson output_length "$output_length" \
        --argjson has_permission_denials "$has_permission_denials" \
        --argjson permission_denial_count "$permission_denial_count" \
        --argjson denied_commands "$denied_commands_json" \
        --arg tests_status "$tests_status" \
        '{
            loop_number: $loop_number,
            timestamp: $timestamp,
            output_file: $output_file,
            output_format: $output_format,
            analysis: {
                has_completion_signal: $has_completion_signal,
                is_test_only: $is_test_only,
                is_stuck: $is_stuck,
                has_progress: $has_progress,
                files_modified: $files_modified,
                format_confidence: $format_confidence,
                confidence_score: $confidence_score,
                exit_signal: $exit_signal,
                tasks_completed_this_loop: $tasks_completed_this_loop,
                tests_status: $tests_status,
                fix_plan_completed_delta: 0,
                has_progress_tracking_mismatch: false,
                work_summary: $work_summary,
                output_length: $output_length,
                has_permission_denials: $has_permission_denials,
                permission_denial_count: $permission_denial_count,
                denied_commands: $denied_commands
            }
        }' > "$analysis_result_file"

    # Always return 0 (success) - callers should check the JSON result file
    # Returning non-zero would cause issues with set -e and test frameworks
    return 0
}

# Update exit signals file based on analysis
update_exit_signals() {
    local analysis_file=${1:-"$RALPH_DIR/.response_analysis"}
    local exit_signals_file=${2:-"$RALPH_DIR/.exit_signals"}

    if [[ ! -f "$analysis_file" ]]; then
        echo "ERROR: Analysis file not found: $analysis_file"
        return 1
    fi

    # Read analysis results
    local is_test_only=$(jq -r -j '.analysis.is_test_only' "$analysis_file")
    local has_completion_signal=$(jq -r -j '.analysis.has_completion_signal' "$analysis_file")
    local loop_number=$(jq -r -j '.loop_number' "$analysis_file")
    local has_progress=$(jq -r -j '.analysis.has_progress' "$analysis_file")
    local has_permission_denials=$(jq -r -j '.analysis.has_permission_denials // false' "$analysis_file")
    local has_progress_tracking_mismatch=$(jq -r -j '.analysis.has_progress_tracking_mismatch // false' "$analysis_file")

    # Read current exit signals
    local signals=$(cat "$exit_signals_file" 2>/dev/null || echo '{"test_only_loops": [], "done_signals": [], "completion_indicators": []}')

    # Update test_only_loops array
    if [[ "$is_test_only" == "true" ]]; then
        signals=$(echo "$signals" | jq ".test_only_loops += [$loop_number]")
    else
        # Clear test_only_loops if we had implementation
        if [[ "$has_progress" == "true" ]]; then
            signals=$(echo "$signals" | jq '.test_only_loops = []')
        fi
    fi

    # Permission denials are handled in the same loop, so they must not become
    # completion state that can halt the next loop.
    if [[ "$has_permission_denials" != "true" && "$has_progress_tracking_mismatch" != "true" && "$has_completion_signal" == "true" ]]; then
        signals=$(echo "$signals" | jq ".done_signals += [$loop_number]")
    fi

    # Update completion_indicators array (only when Claude explicitly signals exit)
    # Note: Format confidence (parse quality) is separated from completion confidence
    # since Issue #124. Only exit_signal drives completion indicators, not confidence score.
    local exit_signal=$(jq -r -j '.analysis.exit_signal // false' "$analysis_file")
    if [[ "$has_permission_denials" != "true" && "$has_progress_tracking_mismatch" != "true" && "$exit_signal" == "true" ]]; then
        signals=$(echo "$signals" | jq ".completion_indicators += [$loop_number]")
    fi

    # Keep only last 5 signals (rolling window)
    signals=$(echo "$signals" | jq '.test_only_loops = .test_only_loops[-5:]')
    signals=$(echo "$signals" | jq '.done_signals = .done_signals[-5:]')
    signals=$(echo "$signals" | jq '.completion_indicators = .completion_indicators[-5:]')

    # Write updated signals
    echo "$signals" > "$exit_signals_file"

    return 0
}

# Log analysis results in human-readable format
log_analysis_summary() {
    local analysis_file=${1:-"$RALPH_DIR/.response_analysis"}

    if [[ ! -f "$analysis_file" ]]; then
        return 1
    fi

    local loop=$(jq -r -j '.loop_number' "$analysis_file")
    local exit_sig=$(jq -r -j '.analysis.exit_signal' "$analysis_file")
    local format_conf=$(jq -r -j '.analysis.format_confidence // 0' "$analysis_file")
    local confidence=$(jq -r -j '.analysis.confidence_score' "$analysis_file")
    local test_only=$(jq -r -j '.analysis.is_test_only' "$analysis_file")
    local files_changed=$(jq -r -j '.analysis.files_modified' "$analysis_file")
    local summary=$(jq -r -j '.analysis.work_summary' "$analysis_file")

    echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║           Response Analysis - Loop #$loop                 ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
    echo -e "${YELLOW}Exit Signal:${NC}      $exit_sig"
    echo -e "${YELLOW}Parse quality:${NC}    $format_conf%"
    echo -e "${YELLOW}Completion:${NC}       $confidence%"
    echo -e "${YELLOW}Test Only:${NC}        $test_only"
    echo -e "${YELLOW}Files Changed:${NC}    $files_changed"
    echo -e "${YELLOW}Summary:${NC}          $summary"
    echo ""
}

# Detect if Claude is stuck (repeating same errors)
detect_stuck_loop() {
    local current_output=$1
    local history_dir=${2:-"$RALPH_DIR/logs"}

    # Get last 3 output files
    local recent_outputs=$(ls -t "$history_dir"/claude_output_*.log 2>/dev/null | head -3)

    if [[ -z "$recent_outputs" ]]; then
        return 1  # Not enough history
    fi

    # Extract key errors from current output using two-stage filtering
    # Stage 1: Filter out JSON field patterns to avoid false positives
    # Stage 2: Extract actual error messages
    local current_errors=$(grep -v '"[^"]*error[^"]*":' "$current_output" 2>/dev/null | \
                          grep -E '(^Error:|^ERROR:|^error:|\]: error|Link: error|Error occurred|failed with error|[Ee]xception|Fatal|FATAL)' 2>/dev/null | \
                          sort | uniq)

    if [[ -z "$current_errors" ]]; then
        return 1  # No errors
    fi

    # Check if same errors appear in all recent outputs
    # For multi-line errors, verify ALL error lines appear in ALL history files
    local all_files_match=true
    while IFS= read -r output_file; do
        local file_matches_all=true
        while IFS= read -r error_line; do
            # Use -F for literal fixed-string matching (not regex)
            if ! grep -qF "$error_line" "$output_file" 2>/dev/null; then
                file_matches_all=false
                break
            fi
        done <<< "$current_errors"

        if [[ "$file_matches_all" != "true" ]]; then
            all_files_match=false
            break
        fi
    done <<< "$recent_outputs"

    if [[ "$all_files_match" == "true" ]]; then
        return 0  # Stuck on same error(s)
    else
        return 1  # Making progress or different errors
    fi
}

# =============================================================================
# SESSION MANAGEMENT FUNCTIONS
# =============================================================================

# Session file location - standardized across ralph_loop.sh and response_analyzer.sh
SESSION_FILE="$RALPH_DIR/.claude_session_id"
# Session expiration time in seconds (24 hours)
SESSION_EXPIRATION_SECONDS=86400

get_session_file_age_seconds() {
    if [[ ! -f "$SESSION_FILE" ]]; then
        echo "-1"
        return 1
    fi

    local now
    now=$(get_epoch_seconds)
    local file_time=""

    if file_time=$(stat -c %Y "$SESSION_FILE" 2>/dev/null); then
        :
    elif file_time=$(stat -f %m "$SESSION_FILE" 2>/dev/null); then
        :
    else
        echo "-1"
        return 1
    fi

    echo $((now - file_time))
}

read_session_id_from_file() {
    if [[ ! -f "$SESSION_FILE" ]]; then
        echo ""
        return 1
    fi

    local raw_content
    raw_content=$(cat "$SESSION_FILE" 2>/dev/null)
    if [[ -z "$raw_content" ]]; then
        echo ""
        return 1
    fi

    local session_id=""
    if echo "$raw_content" | jq -e . >/dev/null 2>&1; then
        session_id=$(echo "$raw_content" | jq -r -j '.session_id // .sessionId // ""' 2>/dev/null)
    else
        session_id=$(printf '%s' "$raw_content" | tr -d '\r' | head -n 1)
    fi

    echo "$session_id"
    [[ -n "$session_id" && "$session_id" != "null" ]]
}

# Store session ID to file with timestamp
# Usage: store_session_id "session-uuid-123"
store_session_id() {
    local session_id=$1

    if [[ -z "$session_id" ]]; then
        return 1
    fi

    # Persist the session as a raw ID so the main loop can resume it directly.
    printf '%s\n' "$session_id" > "$SESSION_FILE"

    return 0
}

# Get the last stored session ID
# Returns: session ID string or empty if not found
get_last_session_id() {
    read_session_id_from_file || true
    return 0
}

# Check if the stored session should be resumed
# Returns: 0 (true) if session is valid and recent, 1 (false) otherwise
should_resume_session() {
    if [[ ! -f "$SESSION_FILE" ]]; then
        echo "false"
        return 1
    fi

    local session_id
    session_id=$(read_session_id_from_file) || {
        echo "false"
        return 1
    }

    # Support legacy JSON session files that still carry a timestamp.
    local timestamp=""
    if jq -e . "$SESSION_FILE" >/dev/null 2>&1; then
        timestamp=$(jq -r -j '.timestamp // ""' "$SESSION_FILE" 2>/dev/null)
    fi

    local age=0
    if [[ -n "$timestamp" && "$timestamp" != "null" ]]; then
        # Calculate session age using date utilities
        local now
        now=$(get_epoch_seconds)
        local session_time
        session_time=$(parse_iso_to_epoch "$timestamp")

        # If parse_iso_to_epoch fell back to current epoch, session_time ≈ now → age ≈ 0.
        # That's a safe default: treat unparseable timestamps as fresh rather than expired.
        age=$((now - session_time))
    else
        age=$(get_session_file_age_seconds) || {
            echo "false"
            return 1
        }
    fi

    # Check if session is still valid (less than expiration time)
    if [[ $age -lt $SESSION_EXPIRATION_SECONDS ]]; then
        echo "true"
        return 0
    else
        echo "false"
        return 1
    fi
}

# Export functions for use in ralph_loop.sh
export -f detect_output_format
export -f count_json_documents
export -f normalize_cli_array_response
export -f normalize_codex_jsonl_response
export -f normalize_opencode_jsonl_response
export -f normalize_cursor_stream_json_response
export -f is_codex_jsonl_output
export -f is_opencode_jsonl_output
export -f is_cursor_stream_json_output
export -f normalize_json_output
export -f extract_session_id_from_output
export -f parse_json_response
export -f analyze_response
export -f update_exit_signals
export -f log_analysis_summary
export -f detect_stuck_loop
export -f store_session_id
export -f get_last_session_id
export -f should_resume_session
