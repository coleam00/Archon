#!/bin/bash
# Circuit Breaker Component for Ralph
# Prevents runaway token consumption by detecting stagnation
# Based on Michael Nygard's "Release It!" pattern

# Source date utilities for cross-platform compatibility
source "$(dirname "${BASH_SOURCE[0]}")/date_utils.sh"

# Circuit Breaker States
CB_STATE_CLOSED="CLOSED"        # Normal operation, progress detected
CB_STATE_HALF_OPEN="HALF_OPEN"  # Monitoring mode, checking for recovery
CB_STATE_OPEN="OPEN"            # Failure detected, execution halted

# Circuit Breaker Configuration
# Use RALPH_DIR if set by main script, otherwise default to .ralph
RALPH_DIR="${RALPH_DIR:-.ralph}"
CB_STATE_FILE="$RALPH_DIR/.circuit_breaker_state"
CB_HISTORY_FILE="$RALPH_DIR/.circuit_breaker_history"
# Configurable thresholds - override via environment variables:
# Example: CB_NO_PROGRESS_THRESHOLD=10 ralph --monitor
CB_NO_PROGRESS_THRESHOLD=${CB_NO_PROGRESS_THRESHOLD:-3}        # Open circuit after N loops with no progress
CB_SAME_ERROR_THRESHOLD=${CB_SAME_ERROR_THRESHOLD:-5}          # Open circuit after N loops with same error
CB_OUTPUT_DECLINE_THRESHOLD=${CB_OUTPUT_DECLINE_THRESHOLD:-70} # Open circuit if output declines by >70%
CB_PERMISSION_DENIAL_THRESHOLD=${CB_PERMISSION_DENIAL_THRESHOLD:-2}  # Open circuit after N loops with permission denials (Issue #101)
CB_COOLDOWN_MINUTES=${CB_COOLDOWN_MINUTES:-30}                      # Minutes before OPEN → HALF_OPEN auto-recovery (Issue #160)
CB_AUTO_RESET=${CB_AUTO_RESET:-false}                               # Reset to CLOSED on startup instead of waiting for cooldown

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Initialize circuit breaker
init_circuit_breaker() {
    # Check if state file exists and is valid JSON
    if [[ -f "$CB_STATE_FILE" ]]; then
        if ! jq '.' "$CB_STATE_FILE" > /dev/null 2>&1; then
            # Corrupted, recreate
            rm -f "$CB_STATE_FILE"
        fi
    fi

    if [[ ! -f "$CB_STATE_FILE" ]]; then
        jq -n \
            --arg state "$CB_STATE_CLOSED" \
            --arg last_change "$(get_iso_timestamp)" \
            '{
                state: $state,
                last_change: $last_change,
                consecutive_no_progress: 0,
                consecutive_same_error: 0,
                consecutive_permission_denials: 0,
                last_progress_loop: 0,
                total_opens: 0,
                reason: ""
            }' > "$CB_STATE_FILE"
    fi

    # Ensure history file exists before any transition logging
    if [[ -f "$CB_HISTORY_FILE" ]]; then
        if ! jq '.' "$CB_HISTORY_FILE" > /dev/null 2>&1; then
            # Corrupted, recreate
            rm -f "$CB_HISTORY_FILE"
        fi
    fi

    if [[ ! -f "$CB_HISTORY_FILE" ]]; then
        echo '[]' > "$CB_HISTORY_FILE"
    fi

    # Auto-recovery: check if OPEN state should transition (Issue #160)
    local current_state
    current_state=$(jq -r '.state' "$CB_STATE_FILE" 2>/dev/null || echo "$CB_STATE_CLOSED")

    if [[ "$current_state" == "$CB_STATE_OPEN" ]]; then
        if [[ "$CB_AUTO_RESET" == "true" ]]; then
            # Auto-reset: bypass cooldown, go straight to CLOSED
            local current_loop total_opens
            current_loop=$(jq -r '.current_loop // 0' "$CB_STATE_FILE" 2>/dev/null || echo "0")
            total_opens=$(jq -r '.total_opens // 0' "$CB_STATE_FILE" 2>/dev/null || echo "0")
            log_circuit_transition "$CB_STATE_OPEN" "$CB_STATE_CLOSED" "Auto-reset on startup (CB_AUTO_RESET=true)" "$current_loop"

            jq -n \
                --arg state "$CB_STATE_CLOSED" \
                --arg last_change "$(get_iso_timestamp)" \
                --argjson total_opens "$total_opens" \
                '{
                    state: $state,
                    last_change: $last_change,
                    consecutive_no_progress: 0,
                    consecutive_same_error: 0,
                    consecutive_permission_denials: 0,
                    last_progress_loop: 0,
                    total_opens: $total_opens,
                    reason: "Auto-reset on startup"
                }' > "$CB_STATE_FILE"
        else
            # Cooldown: check if enough time has elapsed to transition to HALF_OPEN
            local opened_at
            opened_at=$(jq -r '.opened_at // .last_change // ""' "$CB_STATE_FILE" 2>/dev/null || echo "")

            if [[ -n "$opened_at" && "$opened_at" != "null" ]]; then
                local opened_epoch current_epoch elapsed_minutes
                opened_epoch=$(parse_iso_to_epoch "$opened_at")
                current_epoch=$(date +%s)
                elapsed_minutes=$(( (current_epoch - opened_epoch) / 60 ))

                if [[ $elapsed_minutes -ge 0 && $elapsed_minutes -ge $CB_COOLDOWN_MINUTES ]]; then
                    local current_loop
                    current_loop=$(jq -r '.current_loop // 0' "$CB_STATE_FILE" 2>/dev/null || echo "0")
                    log_circuit_transition "$CB_STATE_OPEN" "$CB_STATE_HALF_OPEN" "Cooldown elapsed (${elapsed_minutes}m >= ${CB_COOLDOWN_MINUTES}m)" "$current_loop"

                    # Preserve counters but transition state
                    local state_data
                    state_data=$(cat "$CB_STATE_FILE")
                    echo "$state_data" | jq \
                        --arg state "$CB_STATE_HALF_OPEN" \
                        --arg last_change "$(get_iso_timestamp)" \
                        --arg reason "Cooldown recovery: ${elapsed_minutes}m elapsed" \
                        '.state = $state | .last_change = $last_change | .reason = $reason' \
                        > "$CB_STATE_FILE"
                fi
                # If elapsed_minutes < 0 (clock skew), stay OPEN safely
            fi
        fi
    fi
}

# Get current circuit breaker state
get_circuit_state() {
    if [[ ! -f "$CB_STATE_FILE" ]]; then
        echo "$CB_STATE_CLOSED"
        return
    fi

    jq -r '.state' "$CB_STATE_FILE" 2>/dev/null || echo "$CB_STATE_CLOSED"
}

# Check if circuit breaker allows execution
can_execute() {
    local state=$(get_circuit_state)

    if [[ "$state" == "$CB_STATE_OPEN" ]]; then
        return 1  # Circuit is open, cannot execute
    else
        return 0  # Circuit is closed or half-open, can execute
    fi
}

# Record loop execution result
record_loop_result() {
    local loop_number=$1
    local files_changed=$2
    local has_errors=$3
    local output_length=$4

    init_circuit_breaker

    local state_data=$(cat "$CB_STATE_FILE")
    local current_state=$(echo "$state_data" | jq -r '.state')
    local consecutive_no_progress=$(echo "$state_data" | jq -r '.consecutive_no_progress' | tr -d '[:space:]')
    local consecutive_same_error=$(echo "$state_data" | jq -r '.consecutive_same_error' | tr -d '[:space:]')
    local consecutive_permission_denials=$(echo "$state_data" | jq -r '.consecutive_permission_denials // 0' | tr -d '[:space:]')
    local last_progress_loop=$(echo "$state_data" | jq -r '.last_progress_loop' | tr -d '[:space:]')

    # Ensure integers
    consecutive_no_progress=$((consecutive_no_progress + 0))
    consecutive_same_error=$((consecutive_same_error + 0))
    consecutive_permission_denials=$((consecutive_permission_denials + 0))
    last_progress_loop=$((last_progress_loop + 0))

    # Detect progress from multiple sources:
    # 1. Files changed (git diff)
    # 2. Completion signal in response analysis (STATUS: COMPLETE or has_completion_signal)
    # 3. Claude explicitly reported files modified in RALPH_STATUS block
    local has_progress=false
    local has_completion_signal=false
    local ralph_files_modified=0

    # Check response analysis file for completion signals and reported file changes
    local response_analysis_file="$RALPH_DIR/.response_analysis"
    if [[ -f "$response_analysis_file" ]]; then
        # Read completion signal - STATUS: COMPLETE counts as progress even without git changes
        has_completion_signal=$(jq -r '.analysis.has_completion_signal // false' "$response_analysis_file" 2>/dev/null || echo "false")

        # Also check exit_signal (Claude explicitly signaling completion)
        local exit_signal
        exit_signal=$(jq -r '.analysis.exit_signal // false' "$response_analysis_file" 2>/dev/null || echo "false")
        if [[ "$exit_signal" == "true" ]]; then
            has_completion_signal="true"
        fi

        # Check if Claude reported files modified (may differ from git diff if already committed)
        ralph_files_modified=$(jq -r '.analysis.files_modified // 0' "$response_analysis_file" 2>/dev/null || echo "0")
        ralph_files_modified=$((ralph_files_modified + 0))
    fi

    # Track permission denials (Issue #101)
    local has_permission_denials="false"
    if [[ -f "$response_analysis_file" ]]; then
        has_permission_denials=$(jq -r '.analysis.has_permission_denials // false' "$response_analysis_file" 2>/dev/null || echo "false")
    fi

    if [[ "${PERMISSION_DENIAL_MODE:-halt}" == "threshold" && "$has_permission_denials" == "true" ]]; then
        consecutive_permission_denials=$((consecutive_permission_denials + 1))
    else
        consecutive_permission_denials=0
    fi

    # Determine if progress was made
    if [[ $files_changed -gt 0 ]]; then
        # Git shows uncommitted changes - clear progress
        has_progress=true
        consecutive_no_progress=0
        last_progress_loop=$loop_number
    elif [[ "$has_completion_signal" == "true" ]]; then
        # Claude reported STATUS: COMPLETE - this is progress even without git changes
        # (work may have been committed already, or Claude finished analyzing/planning)
        has_progress=true
        consecutive_no_progress=0
        last_progress_loop=$loop_number
    elif [[ $ralph_files_modified -gt 0 ]]; then
        # Claude reported modifying files (may be committed already)
        has_progress=true
        consecutive_no_progress=0
        last_progress_loop=$loop_number
    else
        consecutive_no_progress=$((consecutive_no_progress + 1))
    fi

    # Detect same error repetition
    if [[ "$has_errors" == "true" ]]; then
        consecutive_same_error=$((consecutive_same_error + 1))
    else
        consecutive_same_error=0
    fi

    # Determine new state and reason
    local new_state="$current_state"
    local reason=""

    # State transitions
    case $current_state in
        "$CB_STATE_CLOSED")
            # Normal operation - check for failure conditions
            # Permission denials take highest priority (Issue #101)
            if [[ $consecutive_permission_denials -ge $CB_PERMISSION_DENIAL_THRESHOLD ]]; then
                new_state="$CB_STATE_OPEN"
                reason="Permission denied in $consecutive_permission_denials consecutive loops"
            elif [[ $consecutive_no_progress -ge $CB_NO_PROGRESS_THRESHOLD ]]; then
                new_state="$CB_STATE_OPEN"
                reason="No progress detected in $consecutive_no_progress consecutive loops"
            elif [[ $consecutive_same_error -ge $CB_SAME_ERROR_THRESHOLD ]]; then
                new_state="$CB_STATE_OPEN"
                reason="Same error repeated in $consecutive_same_error consecutive loops"
            elif [[ $consecutive_no_progress -ge 2 ]]; then
                new_state="$CB_STATE_HALF_OPEN"
                reason="Monitoring: $consecutive_no_progress loops without progress"
            fi
            ;;

        "$CB_STATE_HALF_OPEN")
            # Monitoring mode - either recover or fail
            # Permission denials take highest priority (Issue #101)
            if [[ $consecutive_permission_denials -ge $CB_PERMISSION_DENIAL_THRESHOLD ]]; then
                new_state="$CB_STATE_OPEN"
                reason="Permission denied in $consecutive_permission_denials consecutive loops"
            elif [[ "$has_progress" == "true" ]]; then
                new_state="$CB_STATE_CLOSED"
                reason="Progress detected, circuit recovered"
            elif [[ $consecutive_no_progress -ge $CB_NO_PROGRESS_THRESHOLD ]]; then
                new_state="$CB_STATE_OPEN"
                reason="No recovery, opening circuit after $consecutive_no_progress loops"
            fi
            ;;

        "$CB_STATE_OPEN")
            # Circuit is open - stays open (auto-recovery handled in init_circuit_breaker)
            reason="Circuit breaker is open, execution halted"
            ;;
    esac

    # Update state file
    local total_opens=$(echo "$state_data" | jq -r '.total_opens' | tr -d '[:space:]')
    total_opens=$((total_opens + 0))
    if [[ "$new_state" == "$CB_STATE_OPEN" && "$current_state" != "$CB_STATE_OPEN" ]]; then
        total_opens=$((total_opens + 1))
    fi

    # Determine opened_at: set when entering OPEN, preserve when staying OPEN
    local opened_at=""
    if [[ "$new_state" == "$CB_STATE_OPEN" && "$current_state" != "$CB_STATE_OPEN" ]]; then
        # Entering OPEN state - record the timestamp
        opened_at=$(get_iso_timestamp)
    elif [[ "$new_state" == "$CB_STATE_OPEN" && "$current_state" == "$CB_STATE_OPEN" ]]; then
        # Staying OPEN - preserve existing opened_at (fall back to last_change for old state files)
        opened_at=$(echo "$state_data" | jq -r '.opened_at // .last_change // ""' 2>/dev/null)
    fi

    jq -n \
        --arg state "$new_state" \
        --arg last_change "$(get_iso_timestamp)" \
        --argjson consecutive_no_progress "$consecutive_no_progress" \
        --argjson consecutive_same_error "$consecutive_same_error" \
        --argjson consecutive_permission_denials "$consecutive_permission_denials" \
        --argjson last_progress_loop "$last_progress_loop" \
        --argjson total_opens "$total_opens" \
        --arg reason "$reason" \
        --argjson current_loop "$loop_number" \
        '{
            state: $state,
            last_change: $last_change,
            consecutive_no_progress: $consecutive_no_progress,
            consecutive_same_error: $consecutive_same_error,
            consecutive_permission_denials: $consecutive_permission_denials,
            last_progress_loop: $last_progress_loop,
            total_opens: $total_opens,
            reason: $reason,
            current_loop: $current_loop
        }' > "$CB_STATE_FILE"

    # Add opened_at if set (entering or staying in OPEN state)
    if [[ -n "$opened_at" ]]; then
        local tmp
        tmp=$(jq --arg opened_at "$opened_at" '. + {opened_at: $opened_at}' "$CB_STATE_FILE")
        echo "$tmp" > "$CB_STATE_FILE"
    fi

    # Log state transition
    if [[ "$new_state" != "$current_state" ]]; then
        log_circuit_transition "$current_state" "$new_state" "$reason" "$loop_number"
    fi

    # Return exit code based on new state
    if [[ "$new_state" == "$CB_STATE_OPEN" ]]; then
        return 1  # Circuit opened, signal to stop
    else
        return 0  # Can continue
    fi
}

# Log circuit breaker state transitions
log_circuit_transition() {
    local from_state=$1
    local to_state=$2
    local reason=$3
    local loop_number=$4

    local transition
    transition=$(jq -n -c \
        --arg timestamp "$(get_iso_timestamp)" \
        --argjson loop "$loop_number" \
        --arg from_state "$from_state" \
        --arg to_state "$to_state" \
        --arg reason "$reason" \
        '{
            timestamp: $timestamp,
            loop: $loop,
            from_state: $from_state,
            to_state: $to_state,
            reason: $reason
        }')

    local history
    history=$(cat "$CB_HISTORY_FILE")
    history=$(echo "$history" | jq ". += [$transition]")
    echo "$history" > "$CB_HISTORY_FILE"

    # Console log with colors
    case $to_state in
        "$CB_STATE_OPEN")
            echo -e "${RED}🚨 CIRCUIT BREAKER OPENED${NC}"
            echo -e "${RED}Reason: $reason${NC}"
            ;;
        "$CB_STATE_HALF_OPEN")
            echo -e "${YELLOW}⚠️  CIRCUIT BREAKER: Monitoring Mode${NC}"
            echo -e "${YELLOW}Reason: $reason${NC}"
            ;;
        "$CB_STATE_CLOSED")
            echo -e "${GREEN}✅ CIRCUIT BREAKER: Normal Operation${NC}"
            echo -e "${GREEN}Reason: $reason${NC}"
            ;;
    esac
}

# Display circuit breaker status
show_circuit_status() {
    init_circuit_breaker

    local state_data=$(cat "$CB_STATE_FILE")
    local state=$(echo "$state_data" | jq -r '.state')
    local reason=$(echo "$state_data" | jq -r '.reason')
    local no_progress=$(echo "$state_data" | jq -r '.consecutive_no_progress')
    local last_progress=$(echo "$state_data" | jq -r '.last_progress_loop')
    local current_loop=$(echo "$state_data" | jq -r '.current_loop')
    local total_opens=$(echo "$state_data" | jq -r '.total_opens')

    local color=""
    local status_icon=""

    case $state in
        "$CB_STATE_CLOSED")
            color=$GREEN
            status_icon="✅"
            ;;
        "$CB_STATE_HALF_OPEN")
            color=$YELLOW
            status_icon="⚠️ "
            ;;
        "$CB_STATE_OPEN")
            color=$RED
            status_icon="🚨"
            ;;
    esac

    echo -e "${color}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${color}║           Circuit Breaker Status                          ║${NC}"
    echo -e "${color}╚════════════════════════════════════════════════════════════╝${NC}"
    echo -e "${color}State:${NC}                 $status_icon $state"
    echo -e "${color}Reason:${NC}                $reason"
    echo -e "${color}Loops since progress:${NC} $no_progress"
    echo -e "${color}Last progress:${NC}        Loop #$last_progress"
    echo -e "${color}Current loop:${NC}         #$current_loop"
    echo -e "${color}Total opens:${NC}          $total_opens"
    echo ""
}

# Reset circuit breaker (for manual intervention)
reset_circuit_breaker() {
    local reason=${1:-"Manual reset"}

    jq -n \
        --arg state "$CB_STATE_CLOSED" \
        --arg last_change "$(get_iso_timestamp)" \
        --arg reason "$reason" \
        '{
            state: $state,
            last_change: $last_change,
            consecutive_no_progress: 0,
            consecutive_same_error: 0,
            consecutive_permission_denials: 0,
            last_progress_loop: 0,
            total_opens: 0,
            reason: $reason
        }' > "$CB_STATE_FILE"

    echo -e "${GREEN}✅ Circuit breaker reset to CLOSED state${NC}"
}

# Check if loop should halt (used in main loop)
should_halt_execution() {
    local state=$(get_circuit_state)

    if [[ "$state" == "$CB_STATE_OPEN" ]]; then
        show_circuit_status
        echo ""
        echo -e "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${RED}║  EXECUTION HALTED: Circuit Breaker Opened                 ║${NC}"
        echo -e "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
        echo ""
        echo -e "${YELLOW}Ralph has detected that no progress is being made.${NC}"
        echo ""
        echo -e "${YELLOW}Possible reasons:${NC}"
        echo "  • Project may be complete (check .ralph/@fix_plan.md)"
        echo "  • The active driver may be stuck on an error"
        echo "  • .ralph/PROMPT.md may need clarification"
        echo "  • Manual intervention may be required"
        echo ""
        echo -e "${YELLOW}To continue:${NC}"
        echo "  1. Review recent logs: tail -20 .ralph/logs/ralph.log"
        echo "  2. Check recent driver output: ls -lt .ralph/logs/claude_output_*.log | head -1"
        echo "  3. Update .ralph/@fix_plan.md if needed"
        echo "  4. Reset circuit breaker: bash .ralph/ralph_loop.sh --reset-circuit"
        echo ""
        return 0  # Signal to halt
    else
        return 1  # Can continue
    fi
}

# Export functions
export -f init_circuit_breaker
export -f get_circuit_state
export -f can_execute
export -f record_loop_result
export -f show_circuit_status
export -f reset_circuit_breaker
export -f should_halt_execution
