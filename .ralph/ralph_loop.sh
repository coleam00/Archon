#!/bin/bash
# bmalph-version: 2.11.0

# Claude Code Ralph Loop with Rate Limiting and Documentation
# Adaptation of the Ralph technique for Claude Code with usage management

set -e  # Exit on any error

# Note: CLAUDE_CODE_ENABLE_DANGEROUS_PERMISSIONS_IN_SANDBOX and IS_SANDBOX
# environment variables are NOT exported here. Tool restrictions are handled
# via --allowedTools flag in CLAUDE_CMD_ARGS, which is the proper approach.
# Exporting sandbox variables without a verified sandbox would be misleading.

# Source library components
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
source "$SCRIPT_DIR/lib/date_utils.sh"
source "$SCRIPT_DIR/lib/timeout_utils.sh"
source "$SCRIPT_DIR/lib/response_analyzer.sh"
source "$SCRIPT_DIR/lib/circuit_breaker.sh"

# Configuration
# Ralph-specific files live in .ralph/ subfolder
RALPH_DIR="${RALPH_DIR:-.ralph}"
PROMPT_FILE="$RALPH_DIR/PROMPT.md"
LOG_DIR="$RALPH_DIR/logs"
DOCS_DIR="$RALPH_DIR/docs/generated"
STATUS_FILE="$RALPH_DIR/status.json"
PROGRESS_FILE="$RALPH_DIR/progress.json"
CLAUDE_CODE_CMD="claude"
DRIVER_DISPLAY_NAME="Claude Code"
SLEEP_DURATION=3600     # 1 hour in seconds
LIVE_OUTPUT=false       # Show Claude Code output in real-time (streaming)
LIVE_LOG_FILE="$RALPH_DIR/live.log"  # Fixed file for live output monitoring
CALL_COUNT_FILE="$RALPH_DIR/.call_count"
TIMESTAMP_FILE="$RALPH_DIR/.last_reset"
USE_TMUX=false
PENDING_EXIT_REASON=""

# Save environment variable state BEFORE setting defaults
# These are used by load_ralphrc() to determine which values came from environment
_env_MAX_CALLS_PER_HOUR="${MAX_CALLS_PER_HOUR:-}"
_env_CLAUDE_TIMEOUT_MINUTES="${CLAUDE_TIMEOUT_MINUTES:-}"
_env_CLAUDE_OUTPUT_FORMAT="${CLAUDE_OUTPUT_FORMAT:-}"
_env_CLAUDE_ALLOWED_TOOLS="${CLAUDE_ALLOWED_TOOLS:-}"
_env_has_CLAUDE_PERMISSION_MODE="${CLAUDE_PERMISSION_MODE+x}"
_env_CLAUDE_PERMISSION_MODE="${CLAUDE_PERMISSION_MODE:-}"
_env_CLAUDE_USE_CONTINUE="${CLAUDE_USE_CONTINUE:-}"
_env_CLAUDE_SESSION_EXPIRY_HOURS="${CLAUDE_SESSION_EXPIRY_HOURS:-}"
_env_ALLOWED_TOOLS="${ALLOWED_TOOLS:-}"
_env_SESSION_CONTINUITY="${SESSION_CONTINUITY:-}"
_env_SESSION_EXPIRY_HOURS="${SESSION_EXPIRY_HOURS:-}"
_env_PERMISSION_DENIAL_MODE="${PERMISSION_DENIAL_MODE:-}"
_env_RALPH_VERBOSE="${RALPH_VERBOSE:-}"
_env_VERBOSE_PROGRESS="${VERBOSE_PROGRESS:-}"

# CLI flags are parsed before main() runs, so capture explicit values separately.
_CLI_MAX_CALLS_PER_HOUR="${_CLI_MAX_CALLS_PER_HOUR:-}"
_CLI_CLAUDE_TIMEOUT_MINUTES="${_CLI_CLAUDE_TIMEOUT_MINUTES:-}"
_CLI_CLAUDE_OUTPUT_FORMAT="${_CLI_CLAUDE_OUTPUT_FORMAT:-}"
_CLI_ALLOWED_TOOLS="${_CLI_ALLOWED_TOOLS:-}"
_CLI_SESSION_CONTINUITY="${_CLI_SESSION_CONTINUITY:-}"
_CLI_SESSION_EXPIRY_HOURS="${_CLI_SESSION_EXPIRY_HOURS:-}"
_CLI_VERBOSE_PROGRESS="${_CLI_VERBOSE_PROGRESS:-}"
_cli_MAX_CALLS_PER_HOUR="${MAX_CALLS_PER_HOUR:-}"
_cli_CLAUDE_TIMEOUT_MINUTES="${CLAUDE_TIMEOUT_MINUTES:-}"
_cli_CLAUDE_OUTPUT_FORMAT="${CLAUDE_OUTPUT_FORMAT:-}"
_cli_CLAUDE_ALLOWED_TOOLS="${CLAUDE_ALLOWED_TOOLS:-}"
_cli_CLAUDE_USE_CONTINUE="${CLAUDE_USE_CONTINUE:-}"
_cli_CLAUDE_SESSION_EXPIRY_HOURS="${CLAUDE_SESSION_EXPIRY_HOURS:-}"
_cli_VERBOSE_PROGRESS="${VERBOSE_PROGRESS:-}"
_env_CB_COOLDOWN_MINUTES="${CB_COOLDOWN_MINUTES:-}"
_env_CB_AUTO_RESET="${CB_AUTO_RESET:-}"
_env_TEST_COMMAND="${TEST_COMMAND:-}"
_env_QUALITY_GATES="${QUALITY_GATES:-}"
_env_QUALITY_GATE_MODE="${QUALITY_GATE_MODE:-}"
_env_QUALITY_GATE_TIMEOUT="${QUALITY_GATE_TIMEOUT:-}"
_env_QUALITY_GATE_ON_COMPLETION_ONLY="${QUALITY_GATE_ON_COMPLETION_ONLY:-}"
_env_REVIEW_ENABLED="${REVIEW_ENABLED:-}"
_env_REVIEW_INTERVAL="${REVIEW_INTERVAL:-}"
_env_REVIEW_MODE="${REVIEW_MODE:-}"

# Now set defaults (only if not already set by environment)
MAX_CALLS_PER_HOUR="${MAX_CALLS_PER_HOUR:-100}"
VERBOSE_PROGRESS="${VERBOSE_PROGRESS:-false}"
CLAUDE_TIMEOUT_MINUTES="${CLAUDE_TIMEOUT_MINUTES:-15}"
DEFAULT_CLAUDE_ALLOWED_TOOLS="Write,Read,Edit,MultiEdit,Glob,Grep,Task,TodoWrite,WebFetch,WebSearch,EnterPlanMode,ExitPlanMode,NotebookEdit,Bash"
DEFAULT_PERMISSION_DENIAL_MODE="continue"

# Modern Claude CLI configuration (Phase 1.1)
CLAUDE_OUTPUT_FORMAT="${CLAUDE_OUTPUT_FORMAT:-json}"
CLAUDE_ALLOWED_TOOLS="${CLAUDE_ALLOWED_TOOLS:-$DEFAULT_CLAUDE_ALLOWED_TOOLS}"
CLAUDE_PERMISSION_MODE="${CLAUDE_PERMISSION_MODE:-bypassPermissions}"
CLAUDE_USE_CONTINUE="${CLAUDE_USE_CONTINUE:-true}"
PERMISSION_DENIAL_MODE="${PERMISSION_DENIAL_MODE:-$DEFAULT_PERMISSION_DENIAL_MODE}"
CLAUDE_SESSION_FILE="$RALPH_DIR/.claude_session_id" # Session ID persistence file
CLAUDE_MIN_VERSION="2.0.76"              # Minimum required Claude CLI version

# Session management configuration (Phase 1.2)
# Note: SESSION_EXPIRATION_SECONDS is defined in lib/response_analyzer.sh (86400 = 24 hours)
RALPH_SESSION_FILE="$RALPH_DIR/.ralph_session"              # Ralph-specific session tracking (lifecycle)
RALPH_SESSION_HISTORY_FILE="$RALPH_DIR/.ralph_session_history"  # Session transition history
# Session expiration: 24 hours default balances project continuity with fresh context
# Too short = frequent context loss; Too long = stale context causes unpredictable behavior
CLAUDE_SESSION_EXPIRY_HOURS=${CLAUDE_SESSION_EXPIRY_HOURS:-24}

# Quality gates configuration
TEST_COMMAND="${TEST_COMMAND:-}"
QUALITY_GATES="${QUALITY_GATES:-}"
QUALITY_GATE_MODE="${QUALITY_GATE_MODE:-warn}"
QUALITY_GATE_TIMEOUT="${QUALITY_GATE_TIMEOUT:-120}"
QUALITY_GATE_ON_COMPLETION_ONLY="${QUALITY_GATE_ON_COMPLETION_ONLY:-false}"
QUALITY_GATE_RESULTS_FILE="$RALPH_DIR/.quality_gate_results"

# Periodic code review configuration
REVIEW_ENABLED="${REVIEW_ENABLED:-false}"
REVIEW_INTERVAL="${REVIEW_INTERVAL:-5}"
REVIEW_FINDINGS_FILE="$RALPH_DIR/.review_findings.json"
REVIEW_PROMPT_FILE="$RALPH_DIR/REVIEW_PROMPT.md"
REVIEW_LAST_SHA_FILE="$RALPH_DIR/.review_last_sha"

# REVIEW_MODE is derived in initialize_runtime_context() after .ralphrc is loaded.
# This ensures backwards compat: old .ralphrc files with only REVIEW_ENABLED=true
# still map to enhanced mode. Env vars always win via the snapshot/restore mechanism.
REVIEW_MODE="${REVIEW_MODE:-off}"

# Valid tool patterns for --allowed-tools validation
# Default: Claude Code tools. Platform driver overwrites via driver_valid_tools() in main().
# Validation runs in main() after load_platform_driver so the correct patterns are in effect.
VALID_TOOL_PATTERNS=(
    "Write"
    "Read"
    "Edit"
    "MultiEdit"
    "Glob"
    "Grep"
    "Task"
    "TodoWrite"
    "WebFetch"
    "WebSearch"
    "AskUserQuestion"
    "EnterPlanMode"
    "ExitPlanMode"
    "Bash"
    "Bash(git *)"
    "Bash(npm *)"
    "Bash(bats *)"
    "Bash(python *)"
    "Bash(node *)"
    "NotebookEdit"
)
ALLOWED_TOOLS_IGNORED_WARNED=false
PERMISSION_DENIAL_ACTION=""

# Exit detection configuration
EXIT_SIGNALS_FILE="$RALPH_DIR/.exit_signals"
RESPONSE_ANALYSIS_FILE="$RALPH_DIR/.response_analysis"
MAX_CONSECUTIVE_TEST_LOOPS=3
MAX_CONSECUTIVE_DONE_SIGNALS=2
TEST_PERCENTAGE_THRESHOLD=30  # If more than 30% of recent loops are test-only, flag it

# Ralph configuration file
# bmalph installs .ralph/.ralphrc. Fall back to a project-root .ralphrc for
# older standalone Ralph layouts.
RALPHRC_FILE="${RALPHRC_FILE:-$RALPH_DIR/.ralphrc}"
RALPHRC_LOADED=false

# Platform driver (set from .ralphrc or environment)
PLATFORM_DRIVER="${PLATFORM_DRIVER:-claude-code}"
RUNTIME_CONTEXT_LOADED=false

# resolve_ralphrc_file - Resolve the Ralph config path
resolve_ralphrc_file() {
    if [[ -f "$RALPHRC_FILE" ]]; then
        echo "$RALPHRC_FILE"
        return 0
    fi

    if [[ "$RALPHRC_FILE" != ".ralphrc" && -f ".ralphrc" ]]; then
        echo ".ralphrc"
        return 0
    fi

    echo "$RALPHRC_FILE"
}

# load_ralphrc - Load project-specific configuration from .ralph/.ralphrc
#
# This function sources the bundled .ralph/.ralphrc file when present, falling
# back to a project-root .ralphrc for older standalone Ralph layouts.
# Environment variables take precedence over config values.
#
# Configuration values that can be overridden:
#   - MAX_CALLS_PER_HOUR
#   - CLAUDE_TIMEOUT_MINUTES
#   - CLAUDE_OUTPUT_FORMAT
#   - CLAUDE_PERMISSION_MODE
#   - ALLOWED_TOOLS (mapped to CLAUDE_ALLOWED_TOOLS for Claude Code only)
#   - PERMISSION_DENIAL_MODE
#   - SESSION_CONTINUITY (mapped to CLAUDE_USE_CONTINUE)
#   - SESSION_EXPIRY_HOURS (mapped to CLAUDE_SESSION_EXPIRY_HOURS)
#   - CB_NO_PROGRESS_THRESHOLD
#   - CB_SAME_ERROR_THRESHOLD
#   - CB_OUTPUT_DECLINE_THRESHOLD
#   - RALPH_VERBOSE
#
load_ralphrc() {
    local config_file
    config_file="$(resolve_ralphrc_file)"

    if [[ ! -f "$config_file" ]]; then
        return 0
    fi

    # Source config (this may override default values)
    # shellcheck source=/dev/null
    source "$config_file"

    # Map config variable names to internal names
    if [[ -n "${ALLOWED_TOOLS:-}" ]]; then
        CLAUDE_ALLOWED_TOOLS="$ALLOWED_TOOLS"
    fi
    if [[ -n "${PERMISSION_DENIAL_MODE:-}" ]]; then
        PERMISSION_DENIAL_MODE="$PERMISSION_DENIAL_MODE"
    fi
    if [[ -n "${SESSION_CONTINUITY:-}" ]]; then
        CLAUDE_USE_CONTINUE="$SESSION_CONTINUITY"
    fi
    if [[ -n "${SESSION_EXPIRY_HOURS:-}" ]]; then
        CLAUDE_SESSION_EXPIRY_HOURS="$SESSION_EXPIRY_HOURS"
    fi
    if [[ -n "${RALPH_VERBOSE:-}" ]]; then
        VERBOSE_PROGRESS="$RALPH_VERBOSE"
    fi

    # Restore ONLY values that were explicitly set via environment variables
    # (not script defaults). The _env_* variables were captured BEFORE defaults were set.
    # Internal CLAUDE_* variables are kept for backward compatibility.
    [[ -n "$_env_MAX_CALLS_PER_HOUR" ]] && MAX_CALLS_PER_HOUR="$_env_MAX_CALLS_PER_HOUR"
    [[ -n "$_env_CLAUDE_TIMEOUT_MINUTES" ]] && CLAUDE_TIMEOUT_MINUTES="$_env_CLAUDE_TIMEOUT_MINUTES"
    [[ -n "$_env_CLAUDE_OUTPUT_FORMAT" ]] && CLAUDE_OUTPUT_FORMAT="$_env_CLAUDE_OUTPUT_FORMAT"
    [[ -n "$_env_CLAUDE_ALLOWED_TOOLS" ]] && CLAUDE_ALLOWED_TOOLS="$_env_CLAUDE_ALLOWED_TOOLS"
    if [[ "$_env_has_CLAUDE_PERMISSION_MODE" == "x" ]]; then
        CLAUDE_PERMISSION_MODE="$_env_CLAUDE_PERMISSION_MODE"
    fi
    [[ -n "$_env_CLAUDE_USE_CONTINUE" ]] && CLAUDE_USE_CONTINUE="$_env_CLAUDE_USE_CONTINUE"
    [[ -n "$_env_CLAUDE_SESSION_EXPIRY_HOURS" ]] && CLAUDE_SESSION_EXPIRY_HOURS="$_env_CLAUDE_SESSION_EXPIRY_HOURS"
    [[ -n "$_env_PERMISSION_DENIAL_MODE" ]] && PERMISSION_DENIAL_MODE="$_env_PERMISSION_DENIAL_MODE"
    [[ -n "$_env_VERBOSE_PROGRESS" ]] && VERBOSE_PROGRESS="$_env_VERBOSE_PROGRESS"

    # Public aliases are the preferred external interface and win over the
    # legacy internal environment variables when both are explicitly set.
    [[ -n "$_env_ALLOWED_TOOLS" ]] && CLAUDE_ALLOWED_TOOLS="$_env_ALLOWED_TOOLS"
    [[ -n "$_env_SESSION_CONTINUITY" ]] && CLAUDE_USE_CONTINUE="$_env_SESSION_CONTINUITY"
    [[ -n "$_env_SESSION_EXPIRY_HOURS" ]] && CLAUDE_SESSION_EXPIRY_HOURS="$_env_SESSION_EXPIRY_HOURS"
    [[ -n "$_env_RALPH_VERBOSE" ]] && VERBOSE_PROGRESS="$_env_RALPH_VERBOSE"

    # CLI flags are the highest-priority runtime inputs because they are
    # parsed before main() and would otherwise be overwritten by .ralphrc.
    # Keep every config-backed CLI flag here so the precedence contract stays
    # consistent: CLI > public env aliases > internal env vars > config.
    [[ "$_CLI_MAX_CALLS_PER_HOUR" == "true" ]] && MAX_CALLS_PER_HOUR="$_cli_MAX_CALLS_PER_HOUR"
    [[ "$_CLI_CLAUDE_TIMEOUT_MINUTES" == "true" ]] && CLAUDE_TIMEOUT_MINUTES="$_cli_CLAUDE_TIMEOUT_MINUTES"
    [[ "$_CLI_CLAUDE_OUTPUT_FORMAT" == "true" ]] && CLAUDE_OUTPUT_FORMAT="$_cli_CLAUDE_OUTPUT_FORMAT"
    [[ "$_CLI_ALLOWED_TOOLS" == "true" ]] && CLAUDE_ALLOWED_TOOLS="$_cli_CLAUDE_ALLOWED_TOOLS"
    [[ "$_CLI_SESSION_CONTINUITY" == "true" ]] && CLAUDE_USE_CONTINUE="$_cli_CLAUDE_USE_CONTINUE"
    [[ "$_CLI_SESSION_EXPIRY_HOURS" == "true" ]] && CLAUDE_SESSION_EXPIRY_HOURS="$_cli_CLAUDE_SESSION_EXPIRY_HOURS"
    [[ "$_CLI_VERBOSE_PROGRESS" == "true" ]] && VERBOSE_PROGRESS="$_cli_VERBOSE_PROGRESS"
    [[ -n "$_env_CB_COOLDOWN_MINUTES" ]] && CB_COOLDOWN_MINUTES="$_env_CB_COOLDOWN_MINUTES"
    [[ -n "$_env_CB_AUTO_RESET" ]] && CB_AUTO_RESET="$_env_CB_AUTO_RESET"
    [[ -n "$_env_TEST_COMMAND" ]] && TEST_COMMAND="$_env_TEST_COMMAND"
    [[ -n "$_env_QUALITY_GATES" ]] && QUALITY_GATES="$_env_QUALITY_GATES"
    [[ -n "$_env_QUALITY_GATE_MODE" ]] && QUALITY_GATE_MODE="$_env_QUALITY_GATE_MODE"
    [[ -n "$_env_QUALITY_GATE_TIMEOUT" ]] && QUALITY_GATE_TIMEOUT="$_env_QUALITY_GATE_TIMEOUT"
    [[ -n "$_env_QUALITY_GATE_ON_COMPLETION_ONLY" ]] && QUALITY_GATE_ON_COMPLETION_ONLY="$_env_QUALITY_GATE_ON_COMPLETION_ONLY"
    [[ -n "$_env_REVIEW_ENABLED" ]] && REVIEW_ENABLED="$_env_REVIEW_ENABLED"
    [[ -n "$_env_REVIEW_INTERVAL" ]] && REVIEW_INTERVAL="$_env_REVIEW_INTERVAL"
    [[ -n "$_env_REVIEW_MODE" ]] && REVIEW_MODE="$_env_REVIEW_MODE"

    normalize_claude_permission_mode
    RALPHRC_FILE="$config_file"
    RALPHRC_LOADED=true
    return 0
}

driver_supports_tool_allowlist() {
    return 1
}

driver_permission_denial_help() {
    echo "  - Review the active driver's permission or approval settings."
    echo "  - ALLOWED_TOOLS in $RALPHRC_FILE only applies to the Claude Code driver."
    echo "  - Keep CLAUDE_PERMISSION_MODE=bypassPermissions for unattended Claude Code loops."
    echo "  - After updating permissions, reset the session and restart the loop."
}

# Source platform driver
load_platform_driver() {
    local driver_file="$SCRIPT_DIR/drivers/${PLATFORM_DRIVER}.sh"
    if [[ ! -f "$driver_file" ]]; then
        log_status "ERROR" "Platform driver not found: $driver_file"
        log_status "ERROR" "Available drivers: $(ls "$SCRIPT_DIR/drivers/"*.sh 2>/dev/null | xargs -n1 basename | sed 's/.sh$//' | tr '\n' ' ')"
        exit 1
    fi
    # shellcheck source=/dev/null
    source "$driver_file"

    # Initialize driver-specific tool patterns
    driver_valid_tools

    # Set CLI binary from driver
    CLAUDE_CODE_CMD="$(driver_cli_binary)"
    DRIVER_DISPLAY_NAME="$(driver_display_name)"

    log_status "INFO" "Platform driver: $DRIVER_DISPLAY_NAME ($CLAUDE_CODE_CMD)"
}

initialize_runtime_context() {
    if [[ "$RUNTIME_CONTEXT_LOADED" == "true" ]]; then
        return 0
    fi

    if load_ralphrc; then
        if [[ "$RALPHRC_LOADED" == "true" ]]; then
            log_status "INFO" "Loaded configuration from $RALPHRC_FILE"
        fi
    fi

    # Derive REVIEW_MODE after .ralphrc load so backwards-compat works:
    # old .ralphrc files with only REVIEW_ENABLED=true map to enhanced mode.
    if [[ "$REVIEW_MODE" == "off" && "$REVIEW_ENABLED" == "true" ]]; then
        REVIEW_MODE="enhanced"
    fi
    # Keep REVIEW_ENABLED in sync for any code that checks it
    [[ "$REVIEW_MODE" != "off" ]] && REVIEW_ENABLED="true" || REVIEW_ENABLED="false"

    # Load platform driver after config so PLATFORM_DRIVER can be overridden.
    load_platform_driver
    RUNTIME_CONTEXT_LOADED=true
}

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

# Initialize directories
mkdir -p "$LOG_DIR" "$DOCS_DIR"

# Check if tmux is available
check_tmux_available() {
    if ! command -v tmux &> /dev/null; then
        log_status "ERROR" "tmux is not installed. Please install tmux or run without --monitor flag."
        echo "Install tmux:"
        echo "  Ubuntu/Debian: sudo apt-get install tmux"
        echo "  macOS: brew install tmux"
        echo "  CentOS/RHEL: sudo yum install tmux"
        exit 1
    fi
}

# Get the tmux base-index for windows (handles custom tmux configurations)
# Returns: the base window index (typically 0 or 1)
get_tmux_base_index() {
    local base_index
    base_index=$(tmux show-options -gv base-index 2>/dev/null)
    # Default to 0 if not set or tmux command fails
    echo "${base_index:-0}"
}

# Setup tmux session with monitor
setup_tmux_session() {
    local session_name="ralph-$(date +%s)"
    local ralph_home="${RALPH_HOME:-$SCRIPT_DIR}"
    local project_dir="$(pwd)"

    initialize_runtime_context

    # Get the tmux base-index to handle custom configurations (e.g., base-index 1)
    local base_win
    base_win=$(get_tmux_base_index)

    log_status "INFO" "Setting up tmux session: $session_name"

    # Initialize live.log file
    echo "=== Ralph Live Output - Waiting for first loop... ===" > "$LIVE_LOG_FILE"

    # Create new tmux session detached (left pane - Ralph loop)
    tmux new-session -d -s "$session_name" -c "$project_dir"

    # Split window vertically (right side)
    tmux split-window -h -t "$session_name" -c "$project_dir"

    # Split right pane horizontally (top: Claude output, bottom: status)
    tmux split-window -v -t "$session_name:${base_win}.1" -c "$project_dir"

    # Right-top pane (pane 1): Live driver output
    tmux send-keys -t "$session_name:${base_win}.1" "tail -f '$project_dir/$LIVE_LOG_FILE'" Enter

    # Right-bottom pane (pane 2): Ralph status monitor
    # Prefer bmalph watch (TypeScript, fully tested) over legacy ralph_monitor.sh
    if command -v bmalph &> /dev/null; then
        tmux send-keys -t "$session_name:${base_win}.2" "bmalph watch" Enter
    elif command -v ralph-monitor &> /dev/null; then
        tmux send-keys -t "$session_name:${base_win}.2" "ralph-monitor" Enter
    else
        tmux send-keys -t "$session_name:${base_win}.2" "'$ralph_home/ralph_monitor.sh'" Enter
    fi

    # Start ralph loop in the left pane (exclude tmux flag to avoid recursion)
    # Forward all CLI parameters that were set by the user
    local ralph_cmd
    if command -v ralph &> /dev/null; then
        ralph_cmd="ralph"
    else
        ralph_cmd="'$ralph_home/ralph_loop.sh'"
    fi

    # Always use --live mode in tmux for real-time streaming
    ralph_cmd="$ralph_cmd --live"

    # Forward --calls if non-default
    if [[ "$MAX_CALLS_PER_HOUR" != "100" ]]; then
        ralph_cmd="$ralph_cmd --calls $MAX_CALLS_PER_HOUR"
    fi
    # Forward --prompt if non-default
    if [[ "$PROMPT_FILE" != "$RALPH_DIR/PROMPT.md" ]]; then
        ralph_cmd="$ralph_cmd --prompt '$PROMPT_FILE'"
    fi
    # Forward --output-format if non-default (default is json)
    if [[ "$CLAUDE_OUTPUT_FORMAT" != "json" ]]; then
        ralph_cmd="$ralph_cmd --output-format $CLAUDE_OUTPUT_FORMAT"
    fi
    # Forward --verbose if enabled
    if [[ "$VERBOSE_PROGRESS" == "true" ]]; then
        ralph_cmd="$ralph_cmd --verbose"
    fi
    # Forward --timeout if non-default (default is 15)
    if [[ "$CLAUDE_TIMEOUT_MINUTES" != "15" ]]; then
        ralph_cmd="$ralph_cmd --timeout $CLAUDE_TIMEOUT_MINUTES"
    fi
    # Forward --allowed-tools only for drivers that support tool allowlists
    if driver_supports_tool_allowlist && [[ "$CLAUDE_ALLOWED_TOOLS" != "$DEFAULT_CLAUDE_ALLOWED_TOOLS" ]]; then
        ralph_cmd="$ralph_cmd --allowed-tools '$CLAUDE_ALLOWED_TOOLS'"
    fi
    # Forward --no-continue if session continuity disabled
    if [[ "$CLAUDE_USE_CONTINUE" == "false" ]]; then
        ralph_cmd="$ralph_cmd --no-continue"
    fi
    # Forward --session-expiry if non-default (default is 24)
    if [[ "$CLAUDE_SESSION_EXPIRY_HOURS" != "24" ]]; then
        ralph_cmd="$ralph_cmd --session-expiry $CLAUDE_SESSION_EXPIRY_HOURS"
    fi
    # Forward --auto-reset-circuit if enabled
    if [[ "$CB_AUTO_RESET" == "true" ]]; then
        ralph_cmd="$ralph_cmd --auto-reset-circuit"
    fi

    tmux send-keys -t "$session_name:${base_win}.0" "$ralph_cmd" Enter

    # Focus on left pane (main ralph loop)
    tmux select-pane -t "$session_name:${base_win}.0"

    # Set pane titles (requires tmux 2.6+)
    tmux select-pane -t "$session_name:${base_win}.0" -T "Ralph Loop"
    tmux select-pane -t "$session_name:${base_win}.1" -T "$DRIVER_DISPLAY_NAME Output"
    tmux select-pane -t "$session_name:${base_win}.2" -T "Status"

    # Set window title
    tmux rename-window -t "$session_name:${base_win}" "Ralph: Loop | Output | Status"

    log_status "SUCCESS" "Tmux session created with 3 panes:"
    log_status "INFO" "  Left:         Ralph loop"
    log_status "INFO" "  Right-top:    $DRIVER_DISPLAY_NAME live output"
    log_status "INFO" "  Right-bottom: Status monitor"
    log_status "INFO" ""
    log_status "INFO" "Use Ctrl+B then D to detach from session"
    log_status "INFO" "Use 'tmux attach -t $session_name' to reattach"

    # Attach to session (this will block until session ends)
    tmux attach-session -t "$session_name"

    exit 0
}

# Initialize call tracking
init_call_tracking() {
    # Debug logging removed for cleaner output
    local current_hour=$(date +%Y%m%d%H)
    local last_reset_hour=""

    if [[ -f "$TIMESTAMP_FILE" ]]; then
        last_reset_hour=$(cat "$TIMESTAMP_FILE")
    fi

    # Reset counter if it's a new hour
    if [[ "$current_hour" != "$last_reset_hour" ]]; then
        echo "0" > "$CALL_COUNT_FILE"
        echo "$current_hour" > "$TIMESTAMP_FILE"
        log_status "INFO" "Call counter reset for new hour: $current_hour"
    fi

    # Initialize exit signals tracking if it doesn't exist
    if [[ ! -f "$EXIT_SIGNALS_FILE" ]]; then
        echo '{"test_only_loops": [], "done_signals": [], "completion_indicators": []}' > "$EXIT_SIGNALS_FILE"
    fi

    # Initialize circuit breaker
    init_circuit_breaker

}

# Log function with timestamps and colors
log_status() {
    local level=$1
    local message=$2
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local color=""
    
    case $level in
        "INFO")  color=$BLUE ;;
        "WARN")  color=$YELLOW ;;
        "ERROR") color=$RED ;;
        "SUCCESS") color=$GREEN ;;
        "LOOP") color=$PURPLE ;;
    esac
    
    # Write to stderr so log messages don't interfere with function return values
    echo -e "${color}[$timestamp] [$level] $message${NC}" >&2
    echo "[$timestamp] [$level] $message" >> "$LOG_DIR/ralph.log"
}

# Human-readable label for a process exit code
describe_exit_code() {
    local code=$1
    case "$code" in
        0)   echo "completed" ;;
        1)   echo "error" ;;
        124) echo "timed out" ;;
        130) echo "interrupted (SIGINT)" ;;
        137) echo "killed (OOM or SIGKILL)" ;;
        143) echo "terminated (SIGTERM)" ;;
        *)   echo "error (exit $code)" ;;
    esac
}

# Update status JSON for external monitoring
update_status() {
    local loop_count=$1
    local calls_made=$2
    local last_action=$3
    local status=$4
    local exit_reason=${5:-""}
    local driver_exit_code=${6:-""}

    jq -n \
        --arg timestamp "$(get_iso_timestamp)" \
        --argjson loop_count "$loop_count" \
        --argjson calls_made "$calls_made" \
        --argjson max_calls "$MAX_CALLS_PER_HOUR" \
        --arg last_action "$last_action" \
        --arg status "$status" \
        --arg exit_reason "$exit_reason" \
        --arg next_reset "$(get_next_hour_time)" \
        --arg driver_exit_code "$driver_exit_code" \
        '{
            timestamp: $timestamp,
            loop_count: $loop_count,
            calls_made_this_hour: $calls_made,
            max_calls_per_hour: $max_calls,
            last_action: $last_action,
            status: $status,
            exit_reason: $exit_reason,
            next_reset: $next_reset,
            driver_exit_code: (if $driver_exit_code != "" then ($driver_exit_code | tonumber) else null end)
        }' > "$STATUS_FILE"

    # Merge quality gate status if results exist
    if [[ -f "$QUALITY_GATE_RESULTS_FILE" ]]; then
        local qg_tmp="$STATUS_FILE.qg_tmp"
        if jq -s '.[0] * {quality_gates: {overall_status: .[1].overall_status, mode: .[1].mode}}' \
            "$STATUS_FILE" "$QUALITY_GATE_RESULTS_FILE" > "$qg_tmp" 2>/dev/null; then
            mv "$qg_tmp" "$STATUS_FILE"
        else
            rm -f "$qg_tmp" 2>/dev/null
        fi
    fi
}

validate_permission_denial_mode() {
    local mode=$1

    case "$mode" in
        continue|halt|threshold)
            return 0
            ;;
        *)
            echo "Error: Invalid PERMISSION_DENIAL_MODE: '$mode'"
            echo "Valid modes: continue halt threshold"
            return 1
            ;;
    esac
}

validate_quality_gate_mode() {
    local mode=$1

    case "$mode" in
        warn|block|circuit-breaker)
            return 0
            ;;
        *)
            echo "Error: Invalid QUALITY_GATE_MODE: '$mode'"
            echo "Valid modes: warn block circuit-breaker"
            return 1
            ;;
    esac
}

validate_quality_gate_timeout() {
    local timeout=$1

    if [[ ! "$timeout" =~ ^[0-9]+$ ]] || [[ "$timeout" -eq 0 ]]; then
        echo "Error: QUALITY_GATE_TIMEOUT must be a positive integer, got: '$timeout'"
        return 1
    fi
    return 0
}

normalize_claude_permission_mode() {
    if [[ -z "${CLAUDE_PERMISSION_MODE:-}" ]]; then
        CLAUDE_PERMISSION_MODE="bypassPermissions"
    fi
}

validate_claude_permission_mode() {
    local mode=$1

    case "$mode" in
        auto|acceptEdits|bypassPermissions|default|dontAsk|plan)
            return 0
            ;;
        *)
            echo "Error: Invalid CLAUDE_PERMISSION_MODE: '$mode'"
            echo "Valid modes: auto acceptEdits bypassPermissions default dontAsk plan"
            return 1
            ;;
    esac
}

validate_git_repo() {
    if ! command -v git &>/dev/null; then
        log_status "ERROR" "git is not installed or not on PATH."
        echo ""
        echo "Ralph requires git for progress detection."
        echo ""
        echo "Install git:"
        echo "  macOS:   brew install git  (or: xcode-select --install)"
        echo "  Ubuntu:  sudo apt-get install git"
        echo "  Windows: https://git-scm.com/downloads"
        echo ""
        echo "After installing, run this command again."
        return 1
    fi

    if ! git rev-parse --git-dir &>/dev/null 2>&1; then
        log_status "ERROR" "No git repository found in $(pwd)."
        echo ""
        echo "Ralph requires a git repository for progress detection."
        echo ""
        echo "To fix this, run:"
        echo "  git init && git add -A && git commit -m 'initial commit'"
        return 1
    fi

    if ! git rev-parse HEAD &>/dev/null 2>&1; then
        log_status "ERROR" "Git repository has no commits."
        echo ""
        echo "Ralph requires at least one commit for progress detection."
        echo ""
        echo "To fix this, run:"
        echo "  git add -A && git commit -m 'initial commit'"
        return 1
    fi

    return 0
}

warn_if_allowed_tools_ignored() {
    if driver_supports_tool_allowlist; then
        return 0
    fi

    if [[ "$ALLOWED_TOOLS_IGNORED_WARNED" == "true" ]]; then
        return 0
    fi

    if [[ "${_CLI_ALLOWED_TOOLS:-}" == "true" || "$CLAUDE_ALLOWED_TOOLS" != "$DEFAULT_CLAUDE_ALLOWED_TOOLS" ]]; then
        log_status "WARN" "ALLOWED_TOOLS/--allowed-tools is ignored by $DRIVER_DISPLAY_NAME."
        ALLOWED_TOOLS_IGNORED_WARNED=true
    fi

    return 0
}

show_current_allowed_tools() {
    if ! driver_supports_tool_allowlist; then
        return 0
    fi

    if [[ -f "$RALPHRC_FILE" ]]; then
        local current_tools=$(grep "^ALLOWED_TOOLS=" "$RALPHRC_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"')
        if [[ -n "$current_tools" ]]; then
            echo -e "${BLUE}Current ALLOWED_TOOLS:${NC} $current_tools"
            echo ""
        fi
    fi

    return 0
}

response_analysis_has_permission_denials() {
    if [[ ! -f "$RESPONSE_ANALYSIS_FILE" ]]; then
        return 1
    fi

    local has_permission_denials
    has_permission_denials=$(jq -r '.analysis.has_permission_denials // false' "$RESPONSE_ANALYSIS_FILE" 2>/dev/null || echo "false")

    [[ "$has_permission_denials" == "true" ]]
}

get_response_analysis_denied_commands() {
    if [[ ! -f "$RESPONSE_ANALYSIS_FILE" ]]; then
        echo "unknown"
        return 0
    fi

    jq -r '.analysis.denied_commands | join(", ")' "$RESPONSE_ANALYSIS_FILE" 2>/dev/null || echo "unknown"
}

clear_response_analysis_permission_denials() {
    if [[ ! -f "$RESPONSE_ANALYSIS_FILE" ]]; then
        return 0
    fi

    local tmp_file="$RESPONSE_ANALYSIS_FILE.tmp"
    if jq '
        (.analysis //= {}) |
        .analysis.has_completion_signal = false |
        .analysis.exit_signal = false |
        .analysis.has_permission_denials = false |
        .analysis.permission_denial_count = 0 |
        .analysis.denied_commands = []
    ' "$RESPONSE_ANALYSIS_FILE" > "$tmp_file" 2>/dev/null; then
        mv "$tmp_file" "$RESPONSE_ANALYSIS_FILE"
        return 0
    fi

    rm -f "$tmp_file" 2>/dev/null
    return 1
}

handle_permission_denial() {
    local loop_count=$1
    local denied_cmds=${2:-unknown}
    local calls_made
    calls_made=$(cat "$CALL_COUNT_FILE" 2>/dev/null || echo "0")
    PERMISSION_DENIAL_ACTION=""

    case "$PERMISSION_DENIAL_MODE" in
        continue|threshold)
            log_status "WARN" "🚫 Permission denied in loop #$loop_count: $denied_cmds"
            log_status "WARN" "PERMISSION_DENIAL_MODE=$PERMISSION_DENIAL_MODE - continuing execution"
            update_status "$loop_count" "$calls_made" "permission_denied" "running"
            PERMISSION_DENIAL_ACTION="continue"
            return 0
            ;;
        halt)
            log_status "ERROR" "🚫 Permission denied - halting loop"
            reset_session "permission_denied"
            update_status "$loop_count" "$calls_made" "permission_denied" "halted" "permission_denied"

            echo ""
            echo -e "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
            echo -e "${RED}║  PERMISSION DENIED - Loop Halted                          ║${NC}"
            echo -e "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
            echo ""
            echo -e "${YELLOW}$DRIVER_DISPLAY_NAME was denied permission to execute commands.${NC}"
            echo ""
            echo -e "${YELLOW}To fix this:${NC}"
            driver_permission_denial_help
            echo ""
            show_current_allowed_tools
            PERMISSION_DENIAL_ACTION="halt"
            return 0
            ;;
    esac

    return 1
}

consume_current_loop_permission_denial() {
    local loop_count=$1
    PERMISSION_DENIAL_ACTION=""

    if ! response_analysis_has_permission_denials; then
        return 1
    fi

    local denied_cmds
    denied_cmds=$(get_response_analysis_denied_commands)

    if ! clear_response_analysis_permission_denials; then
        log_status "WARN" "Failed to clear permission denial markers from response analysis"
    fi

    handle_permission_denial "$loop_count" "$denied_cmds"
    return 0
}

# Check if we can make another call
can_make_call() {
    local calls_made=0
    if [[ -f "$CALL_COUNT_FILE" ]]; then
        calls_made=$(cat "$CALL_COUNT_FILE")
    fi
    
    if [[ $calls_made -ge $MAX_CALLS_PER_HOUR ]]; then
        return 1  # Cannot make call
    else
        return 0  # Can make call
    fi
}

# Wait for rate limit reset with countdown
wait_for_reset() {
    local calls_made=$(cat "$CALL_COUNT_FILE" 2>/dev/null || echo "0")
    log_status "WARN" "Rate limit reached ($calls_made/$MAX_CALLS_PER_HOUR). Waiting for reset..."
    
    # Calculate time until next hour
    local current_minute=$(date +%M)
    local current_second=$(date +%S)
    local wait_time=$(((60 - current_minute - 1) * 60 + (60 - current_second)))
    
    log_status "INFO" "Sleeping for $wait_time seconds until next hour..."
    
    # Countdown display
    while [[ $wait_time -gt 0 ]]; do
        local hours=$((wait_time / 3600))
        local minutes=$(((wait_time % 3600) / 60))
        local seconds=$((wait_time % 60))
        
        printf "\r${YELLOW}Time until reset: %02d:%02d:%02d${NC}" $hours $minutes $seconds
        sleep 1
        ((wait_time--))
    done
    printf "\n"
    
    # Reset counter
    echo "0" > "$CALL_COUNT_FILE"
    echo "$(date +%Y%m%d%H)" > "$TIMESTAMP_FILE"
    log_status "SUCCESS" "Rate limit reset! Ready for new calls."
}

count_fix_plan_checkboxes() {
    local fix_plan_file="${1:-$RALPH_DIR/@fix_plan.md}"
    local completed_items=0
    local uncompleted_items=0
    local total_items=0

    if [[ -f "$fix_plan_file" ]]; then
        uncompleted_items=$(grep -cE "^[[:space:]]*- \[ \]" "$fix_plan_file" 2>/dev/null || true)
        [[ -z "$uncompleted_items" ]] && uncompleted_items=0
        completed_items=$(grep -cE "^[[:space:]]*- \[[xX]\]" "$fix_plan_file" 2>/dev/null || true)
        [[ -z "$completed_items" ]] && completed_items=0
    fi

    total_items=$((completed_items + uncompleted_items))
    printf '%s %s %s\n' "$completed_items" "$uncompleted_items" "$total_items"
}

# Extract the first unchecked task line from @fix_plan.md.
# Returns the raw checkbox line trimmed of leading whitespace, capped at 100 chars.
# Outputs empty string if no unchecked tasks exist or file is missing.
# Args: $1 = path to @fix_plan.md (optional, defaults to $RALPH_DIR/@fix_plan.md)
extract_next_fix_plan_task() {
    local fix_plan_file="${1:-$RALPH_DIR/@fix_plan.md}"
    [[ -f "$fix_plan_file" ]] || return 0
    local line
    line=$(grep -m 1 -E "^[[:space:]]*- \[ \]" "$fix_plan_file" 2>/dev/null || true)
    # Trim leading whitespace
    line="${line#"${line%%[![:space:]]*}"}"
    # Trim trailing whitespace
    line="${line%"${line##*[![:space:]]}"}"
    printf '%s' "${line:0:100}"
}

# Collapse completed story detail lines in @fix_plan.md.
# For each [x]/[X] story line, strips subsequent indented blockquote lines (  > ...).
# Incomplete stories keep their detail lines intact.
# Args: $1 = path to @fix_plan.md (modifies in place via atomic write)
collapse_completed_stories() {
    local fix_plan_file="${1:-$RALPH_DIR/@fix_plan.md}"
    [[ -f "$fix_plan_file" ]] || return 0

    local tmp_file="${fix_plan_file}.collapse_tmp"
    local skipping=false

    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*\[[xX]\][[:space:]]*Story[[:space:]]+[0-9] ]]; then
            skipping=true
            printf '%s\n' "$line"
            continue
        fi

        if $skipping && [[ "$line" =~ ^[[:space:]]+\> ]]; then
            continue
        fi

        skipping=false
        printf '%s\n' "$line"
    done < "$fix_plan_file" > "$tmp_file"

    mv "$tmp_file" "$fix_plan_file"
}

enforce_fix_plan_progress_tracking() {
    local analysis_file=$1
    local completed_before=$2
    local completed_after=$3

    if [[ ! -f "$analysis_file" ]]; then
        return 0
    fi

    local claimed_tasks
    claimed_tasks=$(jq -r '.analysis.tasks_completed_this_loop // 0' "$analysis_file" 2>/dev/null || echo "0")
    if [[ ! "$claimed_tasks" =~ ^-?[0-9]+$ ]]; then
        claimed_tasks=0
    fi

    local fix_plan_completed_delta=$((completed_after - completed_before))
    local has_progress_tracking_mismatch=false
    if [[ $claimed_tasks -ne $fix_plan_completed_delta || $claimed_tasks -gt 1 || $fix_plan_completed_delta -gt 1 || $fix_plan_completed_delta -lt 0 ]]; then
        has_progress_tracking_mismatch=true
    fi

    local tmp_file="$analysis_file.tmp"
    if jq \
        --argjson claimed_tasks "$claimed_tasks" \
        --argjson fix_plan_completed_delta "$fix_plan_completed_delta" \
        --argjson has_progress_tracking_mismatch "$has_progress_tracking_mismatch" \
        '
            (.analysis //= {}) |
            .analysis.tasks_completed_this_loop = $claimed_tasks |
            .analysis.fix_plan_completed_delta = $fix_plan_completed_delta |
            .analysis.has_progress_tracking_mismatch = $has_progress_tracking_mismatch |
            if $has_progress_tracking_mismatch then
                .analysis.has_completion_signal = false |
                .analysis.exit_signal = false
            else
                .
            end
        ' "$analysis_file" > "$tmp_file" 2>/dev/null; then
        mv "$tmp_file" "$analysis_file"
    else
        rm -f "$tmp_file" 2>/dev/null
        return 0
    fi

    if [[ "$has_progress_tracking_mismatch" == "true" ]]; then
        log_status "WARN" "Progress tracking mismatch: claimed $claimed_tasks completed task(s) but checkbox delta was $fix_plan_completed_delta. Completion signals suppressed for this loop."
    fi

    return 0
}

# Run the built-in test gate
# Reads tests_status from .response_analysis. If FAILING and TEST_COMMAND is set,
# runs the command to verify. Returns JSON with status/verified/output on stdout.
run_test_gate() {
    local analysis_file=$1

    if [[ ! -f "$analysis_file" ]]; then
        echo '{"status":"skip","tests_status_reported":"","verified":false,"output":""}'
        return 0
    fi

    local tests_status
    tests_status=$(jq -r '.analysis.tests_status // "UNKNOWN"' "$analysis_file" 2>/dev/null || echo "UNKNOWN")

    if [[ "$tests_status" == "UNKNOWN" && -z "$TEST_COMMAND" ]]; then
        echo '{"status":"skip","tests_status_reported":"UNKNOWN","verified":false,"output":""}'
        return 0
    fi

    if [[ "$tests_status" == "PASSING" && -z "$TEST_COMMAND" ]]; then
        jq -n --arg ts "$tests_status" '{"status":"pass","tests_status_reported":$ts,"verified":false,"output":""}'
        return 0
    fi

    if [[ -n "$TEST_COMMAND" ]]; then
        local cmd_output=""
        local cmd_exit=0
        cmd_output=$(portable_timeout "${QUALITY_GATE_TIMEOUT}s" bash -c "$TEST_COMMAND" 2>&1) || cmd_exit=$?
        cmd_output="${cmd_output:0:500}"

        local verified_status="pass"
        if [[ $cmd_exit -ne 0 ]]; then
            verified_status="fail"
        fi

        jq -n \
            --arg status "$verified_status" \
            --arg ts "$tests_status" \
            --arg out "$cmd_output" \
            '{"status":$status,"tests_status_reported":$ts,"verified":true,"output":$out}'
        return 0
    fi

    # No TEST_COMMAND, trust the reported status
    local gate_status="pass"
    if [[ "$tests_status" == "FAILING" ]]; then
        gate_status="fail"
    fi

    jq -n \
        --arg status "$gate_status" \
        --arg ts "$tests_status" \
        '{"status":$status,"tests_status_reported":$ts,"verified":false,"output":""}'
}

# Run user-defined quality gate commands
# Splits QUALITY_GATES on semicolons, runs each with portable_timeout.
# Returns JSON array of results on stdout.
run_custom_gates() {
    if [[ -z "$QUALITY_GATES" ]]; then
        echo "[]"
        return 0
    fi

    local results="[]"
    local gates
    IFS=";" read -ra gates <<< "$QUALITY_GATES"

    for gate_cmd in "${gates[@]}"; do
        gate_cmd=$(echo "$gate_cmd" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        [[ -z "$gate_cmd" ]] && continue

        local cmd_output=""
        local cmd_exit=0
        local start_time
        start_time=$(date +%s)
        local timed_out="false"

        cmd_output=$(portable_timeout "${QUALITY_GATE_TIMEOUT}s" bash -c "$gate_cmd" 2>&1) || cmd_exit=$?

        local end_time
        end_time=$(date +%s)
        local duration=$((end_time - start_time))

        # portable_timeout returns 124 on timeout
        if [[ $cmd_exit -eq 124 ]]; then
            timed_out="true"
        fi

        cmd_output="${cmd_output:0:500}"

        local gate_status="pass"
        if [[ $cmd_exit -ne 0 ]]; then
            gate_status="fail"
        fi

        results=$(echo "$results" | jq \
            --arg cmd "$gate_cmd" \
            --arg status "$gate_status" \
            --argjson exit_code "$cmd_exit" \
            --arg out "$cmd_output" \
            --argjson dur "$duration" \
            --argjson timed_out "$timed_out" \
            '. += [{"command":$cmd,"status":$status,"exit_code":$exit_code,"output":$out,"duration_seconds":$dur,"timed_out":$timed_out}]'
        )
    done

    echo "$results"
}

# Orchestrator: run all quality gates and write results file
# Args: loop_number exit_signal_active
# Returns (on stdout): 0=pass/warn, 1=block failure, 2=circuit-breaker failure
run_quality_gates() {
    local loop_number=$1
    local exit_signal_active=${2:-"false"}

    # Skip if no gates configured
    if [[ -z "$TEST_COMMAND" && -z "$QUALITY_GATES" ]]; then
        echo "0"
        return 0
    fi

    # Skip if completion-only mode and not completing
    if [[ "$QUALITY_GATE_ON_COMPLETION_ONLY" == "true" && "$exit_signal_active" != "true" ]]; then
        echo "0"
        return 0
    fi

    local test_gate_json
    test_gate_json=$(run_test_gate "$RESPONSE_ANALYSIS_FILE")

    local custom_gates_json
    custom_gates_json=$(run_custom_gates)

    # Determine overall status
    local overall_status="pass"
    local test_gate_status
    test_gate_status=$(echo "$test_gate_json" | jq -r '.status' 2>/dev/null || echo "skip")
    if [[ "$test_gate_status" == "fail" ]]; then
        overall_status="fail"
    fi

    local custom_fail_count
    custom_fail_count=$(echo "$custom_gates_json" | jq '[.[] | select(.status == "fail")] | length' 2>/dev/null || echo "0")
    if [[ $custom_fail_count -gt 0 ]]; then
        overall_status="fail"
    fi

    # Write results file atomically (tmp+mv to avoid truncation on jq failure)
    local qg_tmp="$QUALITY_GATE_RESULTS_FILE.tmp"
    if jq -n \
        --arg timestamp "$(get_iso_timestamp)" \
        --argjson loop_number "$loop_number" \
        --argjson test_gate "$test_gate_json" \
        --argjson custom_gates "$custom_gates_json" \
        --arg overall_status "$overall_status" \
        --arg mode "$QUALITY_GATE_MODE" \
        '{
            timestamp: $timestamp,
            loop_number: $loop_number,
            test_gate: $test_gate,
            custom_gates: $custom_gates,
            overall_status: $overall_status,
            mode: $mode
        }' > "$qg_tmp" 2>/dev/null; then
        mv "$qg_tmp" "$QUALITY_GATE_RESULTS_FILE"
    else
        rm -f "$qg_tmp" 2>/dev/null
    fi

    if [[ "$overall_status" == "fail" ]]; then
        log_status "WARN" "Quality gate failure (mode=$QUALITY_GATE_MODE): test_gate=$test_gate_status, custom_failures=$custom_fail_count"
    fi

    # Return code based on mode
    if [[ "$overall_status" == "pass" ]]; then
        echo "0"
        return 0
    fi

    case "$QUALITY_GATE_MODE" in
        block)
            echo "1"
            return 0
            ;;
        circuit-breaker)
            echo "2"
            return 0
            ;;
        *)
            # warn mode: return 0 even on failure
            echo "0"
            return 0
            ;;
    esac
}

# Check if we should gracefully exit
should_exit_gracefully() {

    if [[ ! -f "$EXIT_SIGNALS_FILE" ]]; then
        return 1  # Don't exit, file doesn't exist
    fi
    
    local signals=$(cat "$EXIT_SIGNALS_FILE")
    
    # Count recent signals (last 5 loops) - with error handling
    local recent_test_loops
    local recent_done_signals  
    local recent_completion_indicators
    
    recent_test_loops=$(echo "$signals" | jq '.test_only_loops | length' 2>/dev/null || echo "0")
    recent_done_signals=$(echo "$signals" | jq '.done_signals | length' 2>/dev/null || echo "0")
    recent_completion_indicators=$(echo "$signals" | jq '.completion_indicators | length' 2>/dev/null || echo "0")
    

    # Check for exit conditions

    # 1. Too many consecutive test-only loops
    if [[ $recent_test_loops -ge $MAX_CONSECUTIVE_TEST_LOOPS ]]; then
        log_status "WARN" "Exit condition: Too many test-focused loops ($recent_test_loops >= $MAX_CONSECUTIVE_TEST_LOOPS)"
        echo "test_saturation"
        return 0
    fi
    
    # 2. Multiple "done" signals
    if [[ $recent_done_signals -ge $MAX_CONSECUTIVE_DONE_SIGNALS ]]; then
        log_status "WARN" "Exit condition: Multiple completion signals ($recent_done_signals >= $MAX_CONSECUTIVE_DONE_SIGNALS)"
        echo "completion_signals"
        return 0
    fi
    
    # 3. Safety circuit breaker - force exit after 5 consecutive EXIT_SIGNAL=true responses
    # Note: completion_indicators only accumulates when Claude explicitly sets EXIT_SIGNAL=true
    # (not based on confidence score). This safety breaker catches cases where Claude signals
    # completion 5+ times but the normal exit path (completion_indicators >= 2 + EXIT_SIGNAL=true)
    # didn't trigger for some reason. Threshold of 5 prevents API waste while being higher than
    # the normal threshold (2) to avoid false positives.
    if [[ $recent_completion_indicators -ge 5 ]]; then
        log_status "WARN" "🚨 SAFETY CIRCUIT BREAKER: Force exit after 5 consecutive EXIT_SIGNAL=true responses ($recent_completion_indicators)" >&2
        echo "safety_circuit_breaker"
        return 0
    fi

    # 4. Strong completion indicators (only if Claude's EXIT_SIGNAL is true)
    # This prevents premature exits when heuristics detect completion patterns
    # but Claude explicitly indicates work is still in progress via RALPH_STATUS block.
    # The exit_signal in .response_analysis represents Claude's explicit intent.
    local claude_exit_signal="false"
    if [[ -f "$RESPONSE_ANALYSIS_FILE" ]]; then
        claude_exit_signal=$(jq -r '.analysis.exit_signal // false' "$RESPONSE_ANALYSIS_FILE" 2>/dev/null || echo "false")
    fi

    if [[ $recent_completion_indicators -ge 2 ]] && [[ "$claude_exit_signal" == "true" ]]; then
        log_status "WARN" "Exit condition: Strong completion indicators ($recent_completion_indicators) with EXIT_SIGNAL=true" >&2
        echo "project_complete"
        return 0
    fi
    
    # 5. Check @fix_plan.md for completion
    # Fix #144: Only match valid markdown checkboxes, not date entries like [2026-01-29]
    # Valid patterns: "- [ ]" (uncompleted) and "- [x]" or "- [X]" (completed)
    if [[ -f "$RALPH_DIR/@fix_plan.md" ]]; then
        local completed_items=0
        local uncompleted_items=0
        local total_items=0
        read -r completed_items uncompleted_items total_items < <(count_fix_plan_checkboxes "$RALPH_DIR/@fix_plan.md")

        if [[ $total_items -gt 0 ]] && [[ $completed_items -eq $total_items ]]; then
            log_status "WARN" "Exit condition: All @fix_plan.md items completed ($completed_items/$total_items)" >&2
            echo "plan_complete"
            return 0
        fi
    fi

    echo ""  # Return empty string instead of using return code
}

# =============================================================================
# MODERN CLI HELPER FUNCTIONS (Phase 1.1)
# =============================================================================

# Check Claude CLI version for compatibility with modern flags
check_claude_version() {
    local version=$($CLAUDE_CODE_CMD --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)

    if [[ -z "$version" ]]; then
        log_status "WARN" "Cannot detect Claude CLI version, assuming compatible"
        return 0
    fi

    # Compare versions (simplified semver comparison)
    local required="$CLAUDE_MIN_VERSION"

    # Convert to comparable integers (major * 10000 + minor * 100 + patch)
    local ver_parts=(${version//./ })
    local req_parts=(${required//./ })

    local ver_num=$((${ver_parts[0]:-0} * 10000 + ${ver_parts[1]:-0} * 100 + ${ver_parts[2]:-0}))
    local req_num=$((${req_parts[0]:-0} * 10000 + ${req_parts[1]:-0} * 100 + ${req_parts[2]:-0}))

    if [[ $ver_num -lt $req_num ]]; then
        log_status "WARN" "Claude CLI version $version < $required. Some modern features may not work."
        log_status "WARN" "Consider upgrading: npm update -g @anthropic-ai/claude-code"
        return 1
    fi

    log_status "INFO" "Claude CLI version $version (>= $required) - modern features enabled"
    return 0
}

# Validate allowed tools against whitelist
# Returns 0 if valid, 1 if invalid with error message
validate_allowed_tools() {
    local tools_input=$1

    if [[ -z "$tools_input" ]]; then
        return 0  # Empty is valid (uses defaults)
    fi

    # Split by comma
    local IFS=','
    read -ra tools <<< "$tools_input"

    for tool in "${tools[@]}"; do
        # Trim whitespace
        tool=$(echo "$tool" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

        if [[ -z "$tool" ]]; then
            continue
        fi

        local valid=false

        # Check against valid patterns
        for pattern in "${VALID_TOOL_PATTERNS[@]}"; do
            if [[ "$tool" == "$pattern" ]]; then
                valid=true
                break
            fi

            # Check for Bash(*) pattern - any Bash with parentheses is allowed
            if [[ "$tool" =~ ^Bash\(.+\)$ ]]; then
                valid=true
                break
            fi
        done

        if [[ "$valid" == "false" ]]; then
            echo "Error: Invalid tool in --allowed-tools: '$tool'"
            echo "Valid tools: ${VALID_TOOL_PATTERNS[*]}"
            echo "Note: Bash(...) patterns with any content are allowed (e.g., 'Bash(git *)')"
            return 1
        fi
    done

    return 0
}

# Build loop context for Claude Code session
# Provides loop-specific context via --append-system-prompt
build_loop_context() {
    local loop_count=$1
    local session_id="${2:-}"
    local context=""

    # Add loop number
    context="Loop #${loop_count}. "

    # Signal session continuity when resuming a valid session
    if [[ -n "$session_id" ]]; then
        context+="Session continued — do NOT re-read spec files. Resume implementation. "
    fi

    # Extract incomplete tasks from @fix_plan.md
    # Bug #3 Fix: Support indented markdown checkboxes with [[:space:]]* pattern
    if [[ -f "$RALPH_DIR/@fix_plan.md" ]]; then
        local completed_tasks=0
        local incomplete_tasks=0
        local total_tasks=0
        read -r completed_tasks incomplete_tasks total_tasks < <(count_fix_plan_checkboxes "$RALPH_DIR/@fix_plan.md")
        context+="Remaining tasks: ${incomplete_tasks}. "

        # Inject the next unchecked task to give the AI a clear directive
        local next_task
        next_task=$(extract_next_fix_plan_task "$RALPH_DIR/@fix_plan.md")
        if [[ -n "$next_task" ]]; then
            context+="Next: ${next_task}. "
        fi
    fi

    # Add circuit breaker state
    if [[ -f "$RALPH_DIR/.circuit_breaker_state" ]]; then
        local cb_state=$(jq -r '.state // "UNKNOWN"' "$RALPH_DIR/.circuit_breaker_state" 2>/dev/null)
        if [[ "$cb_state" != "CLOSED" && "$cb_state" != "null" && -n "$cb_state" ]]; then
            context+="Circuit breaker: ${cb_state}. "
        fi
    fi

    # Add previous loop summary (truncated)
    if [[ -f "$RESPONSE_ANALYSIS_FILE" ]]; then
        local prev_summary=$(jq -r '.analysis.work_summary // ""' "$RESPONSE_ANALYSIS_FILE" 2>/dev/null | head -c 200)
        if [[ -n "$prev_summary" && "$prev_summary" != "null" ]]; then
            context+="Previous: ${prev_summary}. "
        fi
    fi

    # Add quality gate failure feedback (block and circuit-breaker modes only)
    if [[ -f "$QUALITY_GATE_RESULTS_FILE" ]]; then
        local qg_status qg_mode
        qg_status=$(jq -r '.overall_status // "pass"' "$QUALITY_GATE_RESULTS_FILE" 2>/dev/null)
        qg_mode=$(jq -r '.mode // "warn"' "$QUALITY_GATE_RESULTS_FILE" 2>/dev/null)

        if [[ "$qg_status" == "fail" && "$qg_mode" != "warn" ]]; then
            local test_gate_status
            test_gate_status=$(jq -r '.test_gate.status // "skip"' "$QUALITY_GATE_RESULTS_FILE" 2>/dev/null)
            if [[ "$test_gate_status" == "fail" ]]; then
                context+="TESTS FAILING. "
            fi

            local failed_gates
            failed_gates=$(jq -r '[.custom_gates[] | select(.status == "fail") | .command | split(" ")[0:2] | join(" ")] | join(", ")' "$QUALITY_GATE_RESULTS_FILE" 2>/dev/null)
            if [[ -n "$failed_gates" ]]; then
                context+="QG fail: ${failed_gates}. "
            fi
        fi
    fi

    # Add git diff summary from previous loop (last segment — truncated first if over budget)
    if [[ -f "$RALPH_DIR/.loop_diff_summary" ]]; then
        local diff_summary
        diff_summary=$(head -c 150 "$RALPH_DIR/.loop_diff_summary" 2>/dev/null)
        if [[ -n "$diff_summary" ]]; then
            context+="${diff_summary}. "
        fi
    fi

    # Limit total length to ~500 chars
    echo "${context:0:500}"
}

# Capture a compact git diff summary after each loop iteration.
# Writes to $RALPH_DIR/.loop_diff_summary for the next loop's build_loop_context().
# Args: $1 = loop_start_sha (git HEAD at loop start)
capture_loop_diff_summary() {
    local loop_start_sha="${1:-}"
    local summary_file="$RALPH_DIR/.loop_diff_summary"

    # Clear previous summary
    rm -f "$summary_file"

    # Require git and a valid repo
    if ! command -v git &>/dev/null || ! git rev-parse --git-dir &>/dev/null 2>&1; then
        return 0
    fi

    local current_sha
    current_sha=$(git rev-parse HEAD 2>/dev/null || echo "")
    local numstat_output=""

    if [[ -n "$loop_start_sha" && -n "$current_sha" && "$loop_start_sha" != "$current_sha" ]]; then
        # Commits exist: union of committed + working tree changes, deduplicated by filename
        numstat_output=$(
            {
                git diff --numstat "$loop_start_sha" HEAD 2>/dev/null
                git diff --numstat HEAD 2>/dev/null
                git diff --numstat --cached 2>/dev/null
            } | awk -F'\t' '!seen[$3]++'
        )
    else
        # No commits: staged + unstaged only
        numstat_output=$(
            {
                git diff --numstat 2>/dev/null
                git diff --numstat --cached 2>/dev/null
            } | awk -F'\t' '!seen[$3]++'
        )
    fi

    [[ -z "$numstat_output" ]] && return 0

    # Format: Changed: file (+add/-del), file2 (+add/-del)
    # Skip binary files (numstat shows - - for binary)
    # Use tab separator — numstat output is tab-delimited (handles filenames with spaces)
    local formatted
    formatted=$(echo "$numstat_output" | awk -F'\t' '
        $1 != "-" {
            if (n++) printf ", "
            printf "%s (+%s/-%s)", $3, $1, $2
        }
    ')

    [[ -z "$formatted" ]] && return 0

    local result="Changed: ${formatted}"
    # Self-truncate to ~150 chars (144 content + "...")
    if [[ ${#result} -gt 147 ]]; then
        result="${result:0:144}..."
    fi

    echo "$result" > "$summary_file"
}

# Check if a code review should run this iteration
# Returns 0 (true) when review is due, 1 (false) otherwise
# Args: $1 = loop_count, $2 = fix_plan_completed_delta (optional, for ultimate mode)
should_run_review() {
    [[ "$REVIEW_MODE" == "off" ]] && return 1
    local loop_count=$1
    local fix_plan_delta=${2:-0}

    # Never review on first loop (no implementation yet)
    (( loop_count < 1 )) && return 1

    # Skip if circuit breaker is not CLOSED
    if [[ -f "$RALPH_DIR/.circuit_breaker_state" ]]; then
        local cb_state
        cb_state=$(jq -r '.state // "CLOSED"' "$RALPH_DIR/.circuit_breaker_state" 2>/dev/null)
        [[ "$cb_state" != "CLOSED" ]] && return 1
    fi

    # Mode-specific trigger
    case "$REVIEW_MODE" in
        enhanced)
            (( loop_count % REVIEW_INTERVAL != 0 )) && return 1
            ;;
        ultimate)
            (( fix_plan_delta < 1 )) && return 1
            ;;
        *)
            # Unknown mode — treat as off
            return 1
            ;;
    esac

    # Skip if no changes since last review (committed or uncommitted)
    if command -v git &>/dev/null && git rev-parse --git-dir &>/dev/null 2>&1; then
        local current_sha last_sha
        current_sha=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
        last_sha=""
        [[ -f "$REVIEW_LAST_SHA_FILE" ]] && last_sha=$(cat "$REVIEW_LAST_SHA_FILE" 2>/dev/null)
        local has_uncommitted
        has_uncommitted=$(git status --porcelain 2>/dev/null | head -1)
        if [[ "$current_sha" == "$last_sha" && -z "$has_uncommitted" ]]; then
            return 1
        fi
    fi
    return 0
}

# Build review findings context for injection into the next implementation loop
# Returns a compact string (max 500-700 chars) with unresolved findings
# HIGH/CRITICAL findings get a PRIORITY prefix and a higher char cap (700)
build_review_context() {
    if [[ ! -f "$REVIEW_FINDINGS_FILE" ]]; then
        echo ""
        return
    fi

    local severity issues_found summary
    severity=$(jq -r '.severity // ""' "$REVIEW_FINDINGS_FILE" 2>/dev/null)
    issues_found=$(jq -r '.issues_found // 0' "$REVIEW_FINDINGS_FILE" 2>/dev/null)
    summary=$(jq -r '.summary // ""' "$REVIEW_FINDINGS_FILE" 2>/dev/null | head -c 300)

    if [[ "$issues_found" == "0" || -z "$severity" || "$severity" == "null" ]]; then
        echo ""
        return
    fi

    # HIGH/CRITICAL findings: instruct the AI to fix them before picking a new story
    local context=""
    local max_len=500
    if [[ "$severity" == "HIGH" || "$severity" == "CRITICAL" ]]; then
        context="PRIORITY: Fix these code review findings BEFORE picking a new story. "
        max_len=700
    fi
    context+="REVIEW FINDINGS ($severity, $issues_found issues): $summary"

    # Include top details if space allows
    local top_details
    top_details=$(jq -r '(.details[:2] // []) | map("- [\(.severity)] \(.file): \(.issue)") | join("; ")' "$REVIEW_FINDINGS_FILE" 2>/dev/null | head -c 150)
    if [[ -n "$top_details" && "$top_details" != "null" ]]; then
        context+=" Details: $top_details"
    fi

    echo "${context:0:$max_len}"
}

# Execute a periodic code review loop (read-only, no file modifications)
# Uses a fresh ephemeral session with restricted tool permissions
run_review_loop() {
    local loop_count=$1

    log_status "INFO" "Starting periodic code review (loop #$loop_count)"

    # Get diff context (committed + uncommitted changes)
    local last_sha=""
    [[ -f "$REVIEW_LAST_SHA_FILE" ]] && last_sha=$(cat "$REVIEW_LAST_SHA_FILE" 2>/dev/null)
    local diff_context=""
    if command -v git &>/dev/null && git rev-parse --git-dir &>/dev/null 2>&1; then
        local committed_diff="" uncommitted_diff=""
        if [[ -n "$last_sha" ]]; then
            committed_diff=$(git diff "$last_sha"..HEAD --stat 2>/dev/null | head -20 || true)
        else
            committed_diff=$(git diff HEAD~5..HEAD --stat 2>/dev/null | head -20 || true)
        fi
        uncommitted_diff=$(git diff --stat 2>/dev/null | head -10 || true)
        diff_context="${committed_diff}"
        if [[ -n "$uncommitted_diff" ]]; then
            diff_context+=$'\nUncommitted:\n'"${uncommitted_diff}"
        fi
        [[ -z "$diff_context" ]] && diff_context="No recent changes"
    fi

    # Check review prompt exists
    if [[ ! -f "$REVIEW_PROMPT_FILE" ]]; then
        log_status "WARN" "Review prompt file not found: $REVIEW_PROMPT_FILE — skipping review"
        return 0
    fi

    # Build review-specific context
    local review_context="CODE REVIEW LOOP (read-only). Analyze changes since last review. Recent changes: $diff_context"

    # Save and override CLAUDE_ALLOWED_TOOLS for read-only mode
    local saved_tools="$CLAUDE_ALLOWED_TOOLS"
    CLAUDE_ALLOWED_TOOLS="Read,Glob,Grep"

    local timeout_seconds=$((CLAUDE_TIMEOUT_MINUTES * 60))
    local review_output_file="$LOG_DIR/review_loop_${loop_count}.log"

    # Build command with review prompt and NO session resume (ephemeral)
    if driver_build_command "$REVIEW_PROMPT_FILE" "$review_context" ""; then
        # Execute review (capture output)
        portable_timeout "${timeout_seconds}s" "${CLAUDE_CMD_ARGS[@]}" \
            < /dev/null > "$review_output_file" 2>&1 || true
    fi

    # Restore CLAUDE_ALLOWED_TOOLS
    CLAUDE_ALLOWED_TOOLS="$saved_tools"

    # Parse review findings from output
    if [[ -f "$review_output_file" ]]; then
        # Review ran successfully — save SHA so we don't re-review the same state
        git rev-parse HEAD > "$REVIEW_LAST_SHA_FILE" 2>/dev/null || true

        local findings_json=""
        # Extract JSON between ---REVIEW_FINDINGS--- and ---END_REVIEW_FINDINGS--- markers
        findings_json=$(sed -n '/---REVIEW_FINDINGS---/,/---END_REVIEW_FINDINGS---/{//!p;}' "$review_output_file" 2>/dev/null | tr -d '\n' | head -c 5000)

        # If output is JSON format, try extracting from result field first
        if [[ -z "$findings_json" ]]; then
            local raw_text
            raw_text=$(jq -r '.result // .content // ""' "$review_output_file" 2>/dev/null || cat "$review_output_file" 2>/dev/null)
            findings_json=$(echo "$raw_text" | sed -n '/---REVIEW_FINDINGS---/,/---END_REVIEW_FINDINGS---/{//!p;}' 2>/dev/null | tr -d '\n' | head -c 5000)
        fi

        if [[ -n "$findings_json" ]]; then
            # Validate it's valid JSON before writing
            if echo "$findings_json" | jq . > /dev/null 2>&1; then
                local tmp_findings="$REVIEW_FINDINGS_FILE.tmp"
                echo "$findings_json" > "$tmp_findings"
                mv "$tmp_findings" "$REVIEW_FINDINGS_FILE"
                local issue_count
                issue_count=$(echo "$findings_json" | jq -r '.issues_found // 0' 2>/dev/null)
                log_status "INFO" "Code review complete. $issue_count issue(s) found."
            else
                log_status "WARN" "Review findings JSON is malformed — skipping"
            fi
        else
            log_status "INFO" "Code review complete. No structured findings extracted."
        fi
    fi
}

# Get session file age in seconds (cross-platform)
# Returns: age in seconds on stdout, or -1 if stat fails
get_session_file_age_seconds() {
    local file=$1

    if [[ ! -f "$file" ]]; then
        echo "0"
        return
    fi

    # Get file modification time using capability detection
    # Handles macOS with Homebrew coreutils where stat flags differ
    local file_mtime

    # Try GNU stat first (Linux, macOS with Homebrew coreutils)
    if file_mtime=$(stat -c %Y "$file" 2>/dev/null) && [[ -n "$file_mtime" && "$file_mtime" =~ ^[0-9]+$ ]]; then
        : # success
    # Try BSD stat (native macOS)
    elif file_mtime=$(stat -f %m "$file" 2>/dev/null) && [[ -n "$file_mtime" && "$file_mtime" =~ ^[0-9]+$ ]]; then
        : # success
    # Fallback to date -r (most portable)
    elif file_mtime=$(date -r "$file" +%s 2>/dev/null) && [[ -n "$file_mtime" && "$file_mtime" =~ ^[0-9]+$ ]]; then
        : # success
    else
        file_mtime=""
    fi

    # Handle stat failure - return -1 to indicate error
    # This prevents false expiration when stat fails
    if [[ -z "$file_mtime" || "$file_mtime" == "0" ]]; then
        echo "-1"
        return
    fi

    local current_time
    current_time=$(date +%s)

    local age_seconds=$((current_time - file_mtime))

    echo "$age_seconds"
}

# Initialize or resume persisted driver session (with expiration check)
#
# Session Expiration Strategy:
# - Default expiration: 24 hours (configurable via CLAUDE_SESSION_EXPIRY_HOURS)
# - 24 hours chosen because: long enough for multi-day projects, short enough
#   to prevent stale context from causing unpredictable behavior
# - Sessions auto-expire to ensure Claude starts fresh periodically
#
# Returns (stdout):
#   - Session ID string: when resuming a valid, non-expired session
#   - Empty string: when starting new session (no file, expired, or stat error)
#
# Return codes:
#   - 0: Always returns success (caller should check stdout for session ID)
#
init_claude_session() {
    if [[ -f "$CLAUDE_SESSION_FILE" ]]; then
        # Check session age
        local age_seconds
        age_seconds=$(get_session_file_age_seconds "$CLAUDE_SESSION_FILE")

        # Handle stat failure (-1) - treat as needing new session
        # Don't expire sessions when we can't determine age
        if [[ $age_seconds -eq -1 ]]; then
            log_status "WARN" "Could not determine session age, starting new session"
            rm -f "$CLAUDE_SESSION_FILE"
            echo ""
            return 0
        fi

        local expiry_seconds=$((CLAUDE_SESSION_EXPIRY_HOURS * 3600))

        # Check if session has expired
        if [[ $age_seconds -ge $expiry_seconds ]]; then
            local age_hours=$((age_seconds / 3600))
            log_status "INFO" "Session expired (${age_hours}h old, max ${CLAUDE_SESSION_EXPIRY_HOURS}h), starting new session"
            rm -f "$CLAUDE_SESSION_FILE"
            echo ""
            return 0
        fi

        # Session is valid, try to read it
        local session_id
        session_id=$(get_last_session_id)
        if [[ -n "$session_id" ]]; then
            local age_hours=$((age_seconds / 3600))
            log_status "INFO" "Resuming session: ${session_id:0:20}... (${age_hours}h old)"
            echo "$session_id"
            return 0
        fi
    fi

    log_status "INFO" "Starting new session"
    echo ""
}

# Save session ID after successful execution
save_claude_session() {
    local output_file=$1

    # Try to extract session ID from structured output
    if [[ -f "$output_file" ]]; then
        local session_id
        if declare -F driver_extract_session_id_from_output >/dev/null; then
            session_id=$(driver_extract_session_id_from_output "$output_file" 2>/dev/null || echo "")
        fi
        if [[ -z "$session_id" || "$session_id" == "null" ]]; then
            session_id=$(extract_session_id_from_output "$output_file" 2>/dev/null || echo "")
        fi
        if [[ -z "$session_id" || "$session_id" == "null" ]] && declare -F driver_fallback_session_id >/dev/null; then
            session_id=$(driver_fallback_session_id "$output_file" 2>/dev/null || echo "")
        fi
        if [[ -n "$session_id" && "$session_id" != "null" ]]; then
            echo "$session_id" > "$CLAUDE_SESSION_FILE"
            sync_ralph_session_with_driver "$session_id"
            log_status "INFO" "Saved session: ${session_id:0:20}..."
        fi
    fi
}

# =============================================================================
# SESSION LIFECYCLE MANAGEMENT FUNCTIONS (Phase 1.2)
# =============================================================================

write_active_ralph_session() {
    local session_id=$1
    local created_at=$2
    local last_used=${3:-$created_at}

    jq -n \
        --arg session_id "$session_id" \
        --arg created_at "$created_at" \
        --arg last_used "$last_used" \
        '{
            session_id: $session_id,
            created_at: $created_at,
            last_used: $last_used
        }' > "$RALPH_SESSION_FILE"
}

write_inactive_ralph_session() {
    local reset_at=$1
    local reset_reason=$2

    jq -n \
        --arg session_id "" \
        --arg reset_at "$reset_at" \
        --arg reset_reason "$reset_reason" \
        '{
            session_id: $session_id,
            reset_at: $reset_at,
            reset_reason: $reset_reason
        }' > "$RALPH_SESSION_FILE"
}

get_ralph_session_state() {
    if [[ ! -f "$RALPH_SESSION_FILE" ]]; then
        echo "missing"
        return 0
    fi

    if ! jq empty "$RALPH_SESSION_FILE" 2>/dev/null; then
        echo "invalid"
        return 0
    fi

    local session_id_type
    session_id_type=$(
        jq -r 'if has("session_id") then (.session_id | type) else "missing" end' \
            "$RALPH_SESSION_FILE" 2>/dev/null
    ) || {
        echo "invalid"
        return 0
    }

    if [[ "$session_id_type" != "string" ]]; then
        echo "invalid"
        return 0
    fi

    local session_id
    session_id=$(jq -r '.session_id' "$RALPH_SESSION_FILE" 2>/dev/null) || {
        echo "invalid"
        return 0
    }

    if [[ "$session_id" == "" ]]; then
        echo "inactive"
        return 0
    fi

    local created_at_type
    created_at_type=$(
        jq -r 'if has("created_at") then (.created_at | type) else "missing" end' \
            "$RALPH_SESSION_FILE" 2>/dev/null
    ) || {
        echo "invalid"
        return 0
    }

    if [[ "$created_at_type" != "string" ]]; then
        echo "invalid"
        return 0
    fi

    local created_at
    created_at=$(jq -r '.created_at' "$RALPH_SESSION_FILE" 2>/dev/null) || {
        echo "invalid"
        return 0
    }

    if ! is_usable_ralph_session_created_at "$created_at"; then
        echo "invalid"
        return 0
    fi

    echo "active"
}

# Get current session ID from Ralph session file
# Returns: session ID string or empty if not found
get_session_id() {
    if [[ ! -f "$RALPH_SESSION_FILE" ]]; then
        echo ""
        return 0
    fi

    # Extract session_id from JSON file (SC2155: separate declare from assign)
    local session_id
    session_id=$(jq -r '.session_id // ""' "$RALPH_SESSION_FILE" 2>/dev/null)
    local jq_status=$?

    # Handle jq failure or null/empty results
    if [[ $jq_status -ne 0 || -z "$session_id" || "$session_id" == "null" ]]; then
        session_id=""
    fi
    echo "$session_id"
    return 0
}

is_usable_ralph_session_created_at() {
    local created_at=$1
    if [[ -z "$created_at" || "$created_at" == "null" ]]; then
        return 1
    fi

    local created_at_epoch
    created_at_epoch=$(parse_iso_to_epoch_strict "$created_at") || return 1

    local now_epoch
    now_epoch=$(get_epoch_seconds)

    [[ "$created_at_epoch" -le "$now_epoch" ]]
}

get_active_session_created_at() {
    if [[ "$(get_ralph_session_state)" != "active" ]]; then
        echo ""
        return 0
    fi

    local created_at
    created_at=$(jq -r '.created_at // ""' "$RALPH_SESSION_FILE" 2>/dev/null)
    if [[ "$created_at" == "null" ]]; then
        created_at=""
    fi

    if ! is_usable_ralph_session_created_at "$created_at"; then
        echo ""
        return 0
    fi

    echo "$created_at"
}

sync_ralph_session_with_driver() {
    local driver_session_id=$1
    if [[ -z "$driver_session_id" || "$driver_session_id" == "null" ]]; then
        return 0
    fi

    local ts
    ts=$(get_iso_timestamp)

    if [[ "$(get_ralph_session_state)" == "active" ]]; then
        local current_session_id
        current_session_id=$(get_session_id)
        local current_created_at
        current_created_at=$(get_active_session_created_at)

        if [[ "$current_session_id" == "$driver_session_id" && -n "$current_created_at" ]]; then
            write_active_ralph_session "$driver_session_id" "$current_created_at" "$ts"
            return 0
        fi
    fi

    write_active_ralph_session "$driver_session_id" "$ts" "$ts"
}

# Reset session with reason logging
# Usage: reset_session "reason_for_reset"
reset_session() {
    local reason=${1:-"manual_reset"}

    # Get current timestamp
    local reset_timestamp
    reset_timestamp=$(get_iso_timestamp)

    write_inactive_ralph_session "$reset_timestamp" "$reason"

    # Also clear the Claude session file for consistency
    rm -f "$CLAUDE_SESSION_FILE" 2>/dev/null

    # Clear exit signals to prevent stale completion indicators from causing premature exit (issue #91)
    # This ensures a fresh start without leftover state from previous sessions
    if [[ -f "$EXIT_SIGNALS_FILE" ]]; then
        echo '{"test_only_loops": [], "done_signals": [], "completion_indicators": []}' > "$EXIT_SIGNALS_FILE"
        [[ "${VERBOSE_PROGRESS:-}" == "true" ]] && log_status "INFO" "Cleared exit signals file"
    fi

    # Clear response analysis to prevent stale EXIT_SIGNAL from previous session
    rm -f "$RESPONSE_ANALYSIS_FILE" 2>/dev/null

    # Log the session transition (non-fatal to prevent script exit under set -e)
    log_session_transition "active" "reset" "$reason" "${loop_count:-0}" || true

    log_status "INFO" "Session reset: $reason"
}

# Log session state transitions to history file
# Usage: log_session_transition from_state to_state reason loop_number
log_session_transition() {
    local from_state=$1
    local to_state=$2
    local reason=$3
    local loop_number=${4:-0}

    # Get timestamp once (SC2155: separate declare from assign)
    local ts
    ts=$(get_iso_timestamp)

    # Create transition entry using jq for safe JSON (SC2155: separate declare from assign)
    local transition
    transition=$(jq -n -c \
        --arg timestamp "$ts" \
        --arg from_state "$from_state" \
        --arg to_state "$to_state" \
        --arg reason "$reason" \
        --argjson loop_number "$loop_number" \
        '{
            timestamp: $timestamp,
            from_state: $from_state,
            to_state: $to_state,
            reason: $reason,
            loop_number: $loop_number
        }')

    # Read history file defensively - fallback to empty array on any failure
    local history
    if [[ -f "$RALPH_SESSION_HISTORY_FILE" ]]; then
        history=$(cat "$RALPH_SESSION_HISTORY_FILE" 2>/dev/null)
        # Validate JSON, fallback to empty array if corrupted
        if ! echo "$history" | jq empty 2>/dev/null; then
            history='[]'
        fi
    else
        history='[]'
    fi

    # Append transition and keep only last 50 entries
    local updated_history
    updated_history=$(echo "$history" | jq ". += [$transition] | .[-50:]" 2>/dev/null)
    local jq_status=$?

    # Only write if jq succeeded
    if [[ $jq_status -eq 0 && -n "$updated_history" ]]; then
        echo "$updated_history" > "$RALPH_SESSION_HISTORY_FILE"
    else
        # Fallback: start fresh with just this transition
        echo "[$transition]" > "$RALPH_SESSION_HISTORY_FILE"
    fi
}

# Generate a unique session ID using timestamp and random component
generate_session_id() {
    local ts
    ts=$(date +%s)
    local rand
    rand=$RANDOM
    echo "ralph-${ts}-${rand}"
}

# Initialize session tracking (called at loop start)
init_session_tracking() {
    local ts
    ts=$(get_iso_timestamp)

    local session_state
    session_state=$(get_ralph_session_state)
    if [[ "$session_state" == "active" ]]; then
        return 0
    fi

    if [[ "$session_state" == "invalid" ]]; then
        log_status "WARN" "Corrupted session file detected, recreating..."
    fi

    local new_session_id
    new_session_id=$(generate_session_id)
    write_active_ralph_session "$new_session_id" "$ts" "$ts"

    log_status "INFO" "Initialized session tracking (session: $new_session_id)"
}

# Update last_used timestamp in session file (called on each loop iteration)
update_session_last_used() {
    if [[ "$(get_ralph_session_state)" != "active" ]]; then
        return 0
    fi

    local ts
    ts=$(get_iso_timestamp)

    local session_id
    session_id=$(get_session_id)
    local created_at
    created_at=$(get_active_session_created_at)

    if [[ -n "$session_id" && -n "$created_at" ]]; then
        write_active_ralph_session "$session_id" "$created_at" "$ts"
    fi
}

# Global array for Claude command arguments (avoids shell injection)
declare -a CLAUDE_CMD_ARGS=()
declare -a LIVE_CMD_ARGS=()

# Build CLI command with platform driver (shell-injection safe)
# Delegates to the active platform driver's driver_build_command()
# Populates global CLAUDE_CMD_ARGS array for direct execution
build_claude_command() {
    driver_build_command "$@"
}

supports_driver_sessions() {
    if declare -F driver_supports_sessions >/dev/null; then
        driver_supports_sessions
        return $?
    fi

    return 0
}

supports_live_output() {
    if declare -F driver_supports_live_output >/dev/null; then
        driver_supports_live_output
        return $?
    fi

    return 0
}

prepare_live_command_args() {
    LIVE_CMD_ARGS=("${CLAUDE_CMD_ARGS[@]}")

    if declare -F driver_prepare_live_command >/dev/null; then
        driver_prepare_live_command
        return $?
    fi

    return 0
}

get_live_stream_filter() {
    if declare -F driver_stream_filter >/dev/null; then
        driver_stream_filter
        return 0
    fi

    echo "empty"
    return 1
}

# Main execution function
execute_claude_code() {
    local timestamp=$(date '+%Y-%m-%d_%H-%M-%S')
    local output_file="$LOG_DIR/claude_output_${timestamp}.log"
    local stderr_file="$LOG_DIR/claude_stderr_${timestamp}.log"
    local loop_count=$1
    local calls_made=$(cat "$CALL_COUNT_FILE" 2>/dev/null || echo "0")
    calls_made=$((calls_made + 1))
    local fix_plan_completed_before=0
    read -r fix_plan_completed_before _ _ < <(count_fix_plan_checkboxes "$RALPH_DIR/@fix_plan.md")

    # Clear previous diff summary to prevent stale context on early exit (#117)
    rm -f "$RALPH_DIR/.loop_diff_summary"

    # Fix #141: Capture git HEAD SHA at loop start to detect commits as progress
    # Store in file for access by progress detection after Claude execution
    local loop_start_sha=""
    if command -v git &>/dev/null && git rev-parse --git-dir &>/dev/null 2>&1; then
        loop_start_sha=$(git rev-parse HEAD 2>/dev/null || echo "")
    fi
    echo "$loop_start_sha" > "$RALPH_DIR/.loop_start_sha"

    log_status "LOOP" "Executing $DRIVER_DISPLAY_NAME (Call $calls_made/$MAX_CALLS_PER_HOUR)"
    local timeout_seconds=$((CLAUDE_TIMEOUT_MINUTES * 60))
    log_status "INFO" "⏳ Starting $DRIVER_DISPLAY_NAME execution... (timeout: ${CLAUDE_TIMEOUT_MINUTES}m)"

    # Initialize or resume session (must happen before build_loop_context
    # so the session_id can gate the "session continued" signal)
    local session_id=""
    if [[ "$CLAUDE_USE_CONTINUE" == "true" ]] && supports_driver_sessions; then
        session_id=$(init_claude_session)
    fi

    # Build loop context for session continuity
    local loop_context=""
    if [[ "$CLAUDE_USE_CONTINUE" == "true" ]]; then
        loop_context=$(build_loop_context "$loop_count" "$session_id")
        if [[ -n "$loop_context" && "$VERBOSE_PROGRESS" == "true" ]]; then
            log_status "INFO" "Loop context: $loop_context"
        fi
    fi

    # Live mode requires JSON output (stream-json) — override text format
    if [[ "$LIVE_OUTPUT" == "true" && "$CLAUDE_OUTPUT_FORMAT" == "text" ]]; then
        log_status "WARN" "Live mode requires JSON output format. Overriding text → json for this session."
        CLAUDE_OUTPUT_FORMAT="json"
    fi

    # Build the Claude CLI command with modern flags
    local use_modern_cli=false

    if build_claude_command "$PROMPT_FILE" "$loop_context" "$session_id"; then
        use_modern_cli=true
        log_status "INFO" "Using modern CLI mode (${CLAUDE_OUTPUT_FORMAT} output)"

        # Build review findings context (separate from loop context)
        local review_context=""
        review_context=$(build_review_context)
        if [[ -n "$review_context" ]]; then
            CLAUDE_CMD_ARGS+=("--append-system-prompt" "$review_context")
        fi
    else
        log_status "WARN" "Failed to build modern CLI command, falling back to legacy mode"
        if [[ "$LIVE_OUTPUT" == "true" ]]; then
            log_status "ERROR" "Live mode requires a built Claude command. Falling back to background mode."
            LIVE_OUTPUT=false
        fi
    fi

    # Execute Claude Code
    local exit_code=0

    # Initialize live.log for this execution
    echo -e "\n\n=== Loop #$loop_count - $(date '+%Y-%m-%d %H:%M:%S') ===" > "$LIVE_LOG_FILE"

    if [[ "$LIVE_OUTPUT" == "true" ]]; then
        # LIVE MODE: Show streaming output in real-time using stream-json + jq
        # Based on: https://www.ytyng.com/en/blog/claude-stream-json-jq/
        #
        # Uses CLAUDE_CMD_ARGS from build_claude_command() to preserve:
        # - --allowedTools (tool permissions)
        # - --append-system-prompt (loop context)
        # - --continue (session continuity)
        # - -p (prompt content)

        if ! supports_live_output; then
            log_status "WARN" "$DRIVER_DISPLAY_NAME does not support structured live streaming. Falling back to background mode."
            LIVE_OUTPUT=false
        fi

        # Check dependencies for live mode
        if [[ "$LIVE_OUTPUT" == "true" ]] && ! command -v jq &> /dev/null; then
            log_status "ERROR" "Live mode requires 'jq' but it's not installed. Falling back to background mode."
            LIVE_OUTPUT=false
        elif [[ "$LIVE_OUTPUT" == "true" ]] && ! command -v stdbuf &> /dev/null; then
            log_status "ERROR" "Live mode requires 'stdbuf' (from coreutils) but it's not installed. Falling back to background mode."
            LIVE_OUTPUT=false
        fi
    fi

    if [[ "$LIVE_OUTPUT" == "true" ]]; then
        # Safety check: live mode requires a successfully built modern command
        if [[ "$use_modern_cli" != "true" || ${#CLAUDE_CMD_ARGS[@]} -eq 0 ]]; then
            log_status "ERROR" "Live mode requires a built Claude command. Falling back to background mode."
            LIVE_OUTPUT=false
        fi
    fi

    if [[ "$LIVE_OUTPUT" == "true" ]]; then
        log_status "INFO" "📺 Live output mode enabled - showing $DRIVER_DISPLAY_NAME streaming..."
        echo -e "${PURPLE}━━━━━━━━━━━━━━━━ ${DRIVER_DISPLAY_NAME} Output ━━━━━━━━━━━━━━━━${NC}"

        if ! prepare_live_command_args; then
            log_status "ERROR" "Failed to prepare live streaming command. Falling back to background mode."
            LIVE_OUTPUT=false
        fi
    fi

    if [[ "$LIVE_OUTPUT" == "true" ]]; then
        local jq_filter
        jq_filter=$(get_live_stream_filter)

        # Execute with streaming, preserving all flags from build_claude_command()
        # Use stdbuf to disable buffering for real-time output
        # Use portable_timeout for consistent timeout protection (Issue: missing timeout)
        # Capture all pipeline exit codes for proper error handling
        # stdin must be redirected from /dev/null because newer Claude CLI versions
        # read from stdin even in -p (print) mode, causing the process to hang
        set -o pipefail
        portable_timeout ${timeout_seconds}s stdbuf -oL "${LIVE_CMD_ARGS[@]}" \
            < /dev/null 2>"$stderr_file" | stdbuf -oL tee "$output_file" | stdbuf -oL jq --unbuffered -j "$jq_filter" 2>/dev/null | tee "$LIVE_LOG_FILE"

        # Capture exit codes from pipeline
        local -a pipe_status=("${PIPESTATUS[@]}")
        set +o pipefail

        # Primary exit code is from Claude/timeout (first command in pipeline)
        exit_code=${pipe_status[0]}

        # Check for tee failures (second command) - could break logging/session
        if [[ ${pipe_status[1]} -ne 0 ]]; then
            log_status "WARN" "Failed to write stream output to log file (exit code ${pipe_status[1]})"
        fi

        # Check for jq failures (third command) - warn but don't fail
        if [[ ${pipe_status[2]} -ne 0 ]]; then
            log_status "WARN" "jq filter had issues parsing some stream events (exit code ${pipe_status[2]})"
        fi

        echo ""
        echo -e "${PURPLE}━━━━━━━━━━━━━━━━ End of Output ━━━━━━━━━━━━━━━━━━━${NC}"

        # Preserve full stream output for downstream analysis and session extraction.
        # Claude-style stream_json can be collapsed to the final result record,
        # while Codex JSONL should remain as event output for the shared parser.
        if [[ "$CLAUDE_USE_CONTINUE" == "true" && -f "$output_file" ]]; then
            local stream_output_file="${output_file%.log}_stream.log"
            cp "$output_file" "$stream_output_file"

            # Collapse Claude-style stream_json to the final result object when present.
            local result_line=$(grep -E '"type"[[:space:]]*:[[:space:]]*"result"' "$output_file" 2>/dev/null | tail -1)

            if [[ -n "$result_line" ]]; then
                if echo "$result_line" | jq -e . >/dev/null 2>&1; then
                    echo "$result_line" > "$output_file"
                    log_status "INFO" "Collapsed streamed response to the final result record"
                else
                    cp "$stream_output_file" "$output_file"
                    log_status "WARN" "Final result record was invalid JSON, keeping full stream output"
                fi
            else
                log_status "INFO" "Keeping full stream output for shared response analysis"
            fi
        fi
    else
        # BACKGROUND MODE: Original behavior with progress monitoring
        if [[ "$use_modern_cli" == "true" ]]; then
            # Modern execution with command array (shell-injection safe)
            # Execute array directly without bash -c to prevent shell metacharacter interpretation
            # stdin must be redirected from /dev/null because newer Claude CLI versions
            # read from stdin even in -p (print) mode, causing SIGTTIN suspension
            # when the process is backgrounded
            if portable_timeout ${timeout_seconds}s "${CLAUDE_CMD_ARGS[@]}" < /dev/null > "$output_file" 2>"$stderr_file" &
            then
                :  # Continue to wait loop
            else
                log_status "ERROR" "❌ Failed to start $DRIVER_DISPLAY_NAME process (modern mode)"
                # Fall back to legacy mode
                log_status "INFO" "Falling back to legacy mode..."
                use_modern_cli=false
            fi
        fi

        # Fall back to legacy stdin piping if modern mode failed or not enabled
        # Note: Legacy mode doesn't use --allowedTools, so tool permissions
        # will be handled by Claude Code's default permission system
        if [[ "$use_modern_cli" == "false" ]]; then
            if portable_timeout ${timeout_seconds}s $CLAUDE_CODE_CMD < "$PROMPT_FILE" > "$output_file" 2>"$stderr_file" &
            then
                :  # Continue to wait loop
            else
                log_status "ERROR" "❌ Failed to start $DRIVER_DISPLAY_NAME process"
                return 1
            fi
        fi

        # Get PID and monitor progress
        local claude_pid=$!
        local progress_counter=0

        # Show progress while Claude Code is running
        while kill -0 $claude_pid 2>/dev/null; do
            progress_counter=$((progress_counter + 1))
            case $((progress_counter % 4)) in
                1) progress_indicator="⠋" ;;
                2) progress_indicator="⠙" ;;
                3) progress_indicator="⠹" ;;
                0) progress_indicator="⠸" ;;
            esac

            # Get last line from output if available
            local last_line=""
            if [[ -f "$output_file" && -s "$output_file" ]]; then
                last_line=$(tail -1 "$output_file" 2>/dev/null | head -c 80)
                # Copy to live.log for tmux monitoring
                cp "$output_file" "$LIVE_LOG_FILE" 2>/dev/null
            fi

            # Update progress file for monitor
            cat > "$PROGRESS_FILE" << EOF
{
    "status": "executing",
    "indicator": "$progress_indicator",
    "elapsed_seconds": $((progress_counter * 10)),
    "last_output": "$last_line",
    "timestamp": "$(date '+%Y-%m-%d %H:%M:%S')"
}
EOF

            # Only log if verbose mode is enabled
            if [[ "$VERBOSE_PROGRESS" == "true" ]]; then
                if [[ -n "$last_line" ]]; then
                    log_status "INFO" "$progress_indicator $DRIVER_DISPLAY_NAME: $last_line... (${progress_counter}0s)"
                else
                    log_status "INFO" "$progress_indicator $DRIVER_DISPLAY_NAME working... (${progress_counter}0s elapsed)"
                fi
            fi

            sleep 10
        done

        # Wait for the process to finish and get exit code
        wait $claude_pid
        exit_code=$?
    fi

    # Expose the raw driver exit code to the main loop for status reporting
    LAST_DRIVER_EXIT_CODE=$exit_code

    if [ $exit_code -eq 0 ]; then
        # Only increment counter on successful execution
        echo "$calls_made" > "$CALL_COUNT_FILE"

        # Clear progress file
        echo '{"status": "completed", "timestamp": "'$(date '+%Y-%m-%d %H:%M:%S')'"}' > "$PROGRESS_FILE"

        log_status "SUCCESS" "✅ $DRIVER_DISPLAY_NAME execution completed successfully"

        # Save session ID from JSON output (Phase 1.1)
        if [[ "$CLAUDE_USE_CONTINUE" == "true" ]] && supports_driver_sessions; then
            save_claude_session "$output_file"
        fi

        # Analyze the response
        log_status "INFO" "🔍 Analyzing $DRIVER_DISPLAY_NAME response..."
        analyze_response "$output_file" "$loop_count"
        local analysis_exit_code=$?

        local fix_plan_completed_after=0
        read -r fix_plan_completed_after _ _ < <(count_fix_plan_checkboxes "$RALPH_DIR/@fix_plan.md")
        enforce_fix_plan_progress_tracking "$RESPONSE_ANALYSIS_FILE" "$fix_plan_completed_before" "$fix_plan_completed_after"

        # Collapse completed story details so the agent doesn't re-read them
        if [[ $fix_plan_completed_after -gt $fix_plan_completed_before ]]; then
            collapse_completed_stories "$RALPH_DIR/@fix_plan.md"
        fi

        # Run quality gates
        local exit_signal_for_gates
        exit_signal_for_gates=$(jq -r '.analysis.exit_signal // false' "$RESPONSE_ANALYSIS_FILE" 2>/dev/null || echo "false")
        local qg_result
        qg_result=$(run_quality_gates "$loop_count" "$exit_signal_for_gates")

        # Block mode: suppress exit signals so the loop keeps running
        if [[ "$qg_result" == "1" ]]; then
            log_status "WARN" "Quality gate block: suppressing completion signals"
            local qg_tmp="$RESPONSE_ANALYSIS_FILE.qg_tmp"
            if jq '.analysis.has_completion_signal = false | .analysis.exit_signal = false' \
                "$RESPONSE_ANALYSIS_FILE" > "$qg_tmp" 2>/dev/null; then
                mv "$qg_tmp" "$RESPONSE_ANALYSIS_FILE"
            else
                rm -f "$qg_tmp" 2>/dev/null
            fi
        fi

        # Update exit signals based on analysis
        update_exit_signals

        # Log analysis summary
        log_analysis_summary

        PENDING_EXIT_REASON=$(should_exit_gracefully)

        # Get file change count for circuit breaker
        # Fix #141: Detect both uncommitted changes AND committed changes
        local files_changed=0
        local loop_start_sha=""
        local current_sha=""

        if [[ -f "$RALPH_DIR/.loop_start_sha" ]]; then
            loop_start_sha=$(cat "$RALPH_DIR/.loop_start_sha" 2>/dev/null || echo "")
        fi

        if command -v git &>/dev/null && git rev-parse --git-dir &>/dev/null 2>&1; then
            current_sha=$(git rev-parse HEAD 2>/dev/null || echo "")

            # Check if commits were made (HEAD changed)
            if [[ -n "$loop_start_sha" && -n "$current_sha" && "$loop_start_sha" != "$current_sha" ]]; then
                # Commits were made - count union of committed files AND working tree changes
                # This catches cases where Claude commits some files but still has other modified files
                files_changed=$(
                    {
                        git diff --name-only "$loop_start_sha" "$current_sha" 2>/dev/null
                        git diff --name-only HEAD 2>/dev/null           # unstaged changes
                        git diff --name-only --cached 2>/dev/null       # staged changes
                    } | sort -u | wc -l
                )
                [[ "$VERBOSE_PROGRESS" == "true" ]] && log_status "DEBUG" "Detected $files_changed unique files changed (commits + working tree) since loop start"
            else
                # No commits - check for uncommitted changes (staged + unstaged)
                files_changed=$(
                    {
                        git diff --name-only 2>/dev/null                # unstaged changes
                        git diff --name-only --cached 2>/dev/null       # staged changes
                    } | sort -u | wc -l
                )
            fi
        fi

        # Capture diff summary for next loop's context (#117)
        capture_loop_diff_summary "$loop_start_sha"

        local has_errors="false"

        # Two-stage error detection to avoid JSON field false positives
        # Stage 1: Filter out JSON field patterns like "is_error": false
        # Stage 2: Look for actual error messages in specific contexts
        # Avoid type annotations like "error: Error" by requiring lowercase after ": error"
        if grep -v '"[^"]*error[^"]*":' "$output_file" 2>/dev/null | \
           grep -qE '(^Error:|^ERROR:|^error:|\]: error|Link: error|Error occurred|failed with error|[Ee]xception|Fatal|FATAL)'; then
            has_errors="true"

            # Debug logging: show what triggered error detection
            if [[ "$VERBOSE_PROGRESS" == "true" ]]; then
                log_status "DEBUG" "Error patterns found:"
                grep -v '"[^"]*error[^"]*":' "$output_file" 2>/dev/null | \
                    grep -nE '(^Error:|^ERROR:|^error:|\]: error|Link: error|Error occurred|failed with error|[Ee]xception|Fatal|FATAL)' | \
                    head -3 | while IFS= read -r line; do
                    log_status "DEBUG" "  $line"
                done
            fi

            log_status "WARN" "Errors detected in output, check: $output_file"
        fi
        local output_length=$(wc -c < "$output_file" 2>/dev/null || echo 0)

        # Circuit-breaker mode: override progress signals so circuit breaker sees no-progress
        if [[ "$qg_result" == "2" ]]; then
            log_status "WARN" "Quality gate circuit-breaker: overriding progress signals"
            files_changed=0
            has_errors="true"
        fi

        # Record result in circuit breaker
        record_loop_result "$loop_count" "$files_changed" "$has_errors" "$output_length"
        local circuit_result=$?

        if [[ $circuit_result -ne 0 ]]; then
            log_status "WARN" "Circuit breaker opened - halting execution"
            return 3  # Special code for circuit breaker trip
        fi

        return 0
    else
        # Clear progress file on failure
        echo '{"status": "failed", "timestamp": "'$(date '+%Y-%m-%d %H:%M:%S')'"}' > "$PROGRESS_FILE"

        # Check if the failure is due to API 5-hour limit
        if grep -qi "5.*hour.*limit\|limit.*reached.*try.*back\|usage.*limit.*reached" "$output_file"; then
            log_status "ERROR" "🚫 Claude API 5-hour usage limit reached"
            return 2  # Special return code for API limit
        else
            local exit_desc
            exit_desc=$(describe_exit_code "$exit_code")
            log_status "ERROR" "❌ $DRIVER_DISPLAY_NAME exited: $exit_desc (code $exit_code)"
            if [[ -f "$stderr_file" && -s "$stderr_file" ]]; then
                log_status "ERROR" "  stderr (last 3 lines): $(tail -3 "$stderr_file")"
                log_status "ERROR" "  full stderr log: $stderr_file"
            fi
            return 1
        fi
    fi
}

# Guard against double cleanup (EXIT fires after signal handler exits)
_CLEANUP_DONE=false

# EXIT trap — catches set -e failures and other unexpected exits
_on_exit() {
    local code=$?
    [[ "$_CLEANUP_DONE" == "true" ]] && return
    _CLEANUP_DONE=true
    if [[ "$code" -ne 0 ]]; then
        local desc
        desc=$(describe_exit_code "$code")
        log_status "ERROR" "Ralph loop exiting unexpectedly: $desc (code $code)"
        update_status "$loop_count" "$(cat "$CALL_COUNT_FILE" 2>/dev/null || echo "0")" "unexpected_exit" "stopped" "$desc" "$code"
    fi
}

# Signal handler — preserves signal identity in exit code
_on_signal() {
    local sig=$1
    log_status "INFO" "Ralph loop interrupted by $sig. Cleaning up..."
    reset_session "manual_interrupt"
    update_status "$loop_count" "$(cat "$CALL_COUNT_FILE" 2>/dev/null || echo "0")" "interrupted" "stopped" "$sig"
    _CLEANUP_DONE=true
    [[ "$sig" == "SIGINT" ]] && exit 130
    exit 143
}

trap _on_exit EXIT
trap '_on_signal SIGINT' SIGINT
trap '_on_signal SIGTERM' SIGTERM

# Global variable for loop count (needed by trap handlers)
loop_count=0

# Main loop
main() {
    initialize_runtime_context

    if ! validate_permission_denial_mode "$PERMISSION_DENIAL_MODE"; then
        exit 1
    fi

    if [[ -n "$QUALITY_GATES" || -n "$TEST_COMMAND" ]]; then
        if ! validate_quality_gate_mode "$QUALITY_GATE_MODE"; then
            exit 1
        fi
        if ! validate_quality_gate_timeout "$QUALITY_GATE_TIMEOUT"; then
            exit 1
        fi
        if ! has_timeout_command; then
            log_status "WARN" "No timeout command available. Quality gate and test commands will fail. Install coreutils to enable timeout support."
        fi
    fi

    if [[ "$(driver_name)" == "claude-code" ]]; then
        normalize_claude_permission_mode

        if ! validate_claude_permission_mode "$CLAUDE_PERMISSION_MODE"; then
            exit 1
        fi
    fi

    if driver_supports_tool_allowlist; then
        # Validate --allowed-tools now that platform-specific VALID_TOOL_PATTERNS are loaded
        if [[ "${_CLI_ALLOWED_TOOLS:-}" == "true" ]] && ! validate_allowed_tools "$CLAUDE_ALLOWED_TOOLS"; then
            exit 1
        fi
    else
        warn_if_allowed_tools_ignored
    fi

    if [[ "${_CLI_ALLOWED_TOOLS:-}" == "true" ]] && ! driver_supports_tool_allowlist; then
        _CLI_ALLOWED_TOOLS=""
    fi

    log_status "SUCCESS" "🚀 Ralph loop starting with $DRIVER_DISPLAY_NAME"
    log_status "INFO" "Max calls per hour: $MAX_CALLS_PER_HOUR"
    log_status "INFO" "Logs: $LOG_DIR/ | Docs: $DOCS_DIR/ | Status: $STATUS_FILE"

    # Check if project uses old flat structure and needs migration
    if [[ -f "PROMPT.md" ]] && [[ ! -d ".ralph" ]]; then
        log_status "ERROR" "This project uses the old flat structure."
        echo ""
        echo "Ralph v0.10.0+ uses a .ralph/ subfolder to keep your project root clean."
        echo ""
        echo "To upgrade your project, run:"
        echo "  ralph-migrate"
        echo ""
        echo "This will move Ralph-specific files to .ralph/ while preserving src/ at root."
        echo "A backup will be created before migration."
        exit 1
    fi

    # Check if this is a Ralph project directory
    if [[ ! -f "$PROMPT_FILE" ]]; then
        log_status "ERROR" "Prompt file '$PROMPT_FILE' not found!"
        echo ""
        
        # Check if this looks like a partial Ralph project
        if [[ -f "$RALPH_DIR/@fix_plan.md" ]] || [[ -d "$RALPH_DIR/specs" ]] || [[ -f "$RALPH_DIR/@AGENT.md" ]]; then
            echo "This appears to be a bmalph/Ralph project but is missing .ralph/PROMPT.md."
            echo "You may need to create or restore the PROMPT.md file."
        else
            echo "This directory is not a bmalph/Ralph project."
        fi

        echo ""
        echo "To fix this:"
        echo "  1. Initialize bmalph in this project: bmalph init"
        echo "  2. Restore bundled Ralph files in an existing project: bmalph upgrade"
        echo "  3. Generate Ralph task files after planning: bmalph implement"
        echo "  4. Navigate to an existing bmalph/Ralph project directory"
        echo "  5. Or create .ralph/PROMPT.md manually in this directory"
        echo ""
        echo "Ralph projects should contain: .ralph/PROMPT.md, .ralph/@fix_plan.md, .ralph/specs/, src/, etc."
        exit 1
    fi

    # Check required dependencies
    if ! command -v jq &> /dev/null; then
        log_status "ERROR" "Required dependency 'jq' is not installed."
        echo ""
        echo "jq is required for JSON processing in the Ralph loop."
        echo ""
        echo "Install jq:"
        echo "  macOS:   brew install jq"
        echo "  Ubuntu:  sudo apt-get install jq"
        echo "  Windows: choco install jq  (or: winget install jqlang.jq)"
        echo ""
        echo "After installing, run this command again."
        exit 1
    fi

    # Check for git repository (required for progress detection)
    if ! validate_git_repo; then
        exit 1
    fi

    # Initialize session tracking before entering the loop
    init_session_tracking

    log_status "INFO" "Starting main loop..."
    
    while true; do
        loop_count=$((loop_count + 1))

        # Update session last_used timestamp
        update_session_last_used

        log_status "INFO" "Loop #$loop_count - calling init_call_tracking..."
        init_call_tracking
        
        log_status "LOOP" "=== Starting Loop #$loop_count ==="
        
        # Check circuit breaker before attempting execution
        if should_halt_execution; then
            reset_session "circuit_breaker_open"
            update_status "$loop_count" "$(cat "$CALL_COUNT_FILE")" "circuit_breaker_open" "halted" "stagnation_detected"
            log_status "ERROR" "🛑 Circuit breaker has opened - execution halted"
            break
        fi

        # Check rate limits
        if ! can_make_call; then
            wait_for_reset
            continue
        fi

        # Check for graceful exit conditions
        local exit_reason=$(should_exit_gracefully)
        if [[ "$exit_reason" != "" ]]; then
            log_status "SUCCESS" "🏁 Graceful exit triggered: $exit_reason"
            reset_session "project_complete"
            update_status "$loop_count" "$(cat "$CALL_COUNT_FILE")" "graceful_exit" "completed" "$exit_reason"

            log_status "SUCCESS" "🎉 Ralph has completed the project! Final stats:"
            log_status "INFO" "  - Total loops: $loop_count"
            log_status "INFO" "  - API calls used: $(cat "$CALL_COUNT_FILE")"
            log_status "INFO" "  - Exit reason: $exit_reason"

            break
        fi
        
        # Update status
        local calls_made=$(cat "$CALL_COUNT_FILE" 2>/dev/null || echo "0")
        update_status "$loop_count" "$calls_made" "executing" "running"
        
        # Execute Claude Code
        execute_claude_code "$loop_count"
        local exec_result=$?
        
        if [ $exec_result -eq 0 ]; then
            if consume_current_loop_permission_denial "$loop_count"; then
                if [[ "$PERMISSION_DENIAL_ACTION" == "halt" ]]; then
                    break
                fi

                # Brief pause between loops when the denial was recorded but
                # policy allows Ralph to continue.
                sleep 5
                continue
            fi

            if [[ -n "$PENDING_EXIT_REASON" ]]; then
                local exit_reason="$PENDING_EXIT_REASON"
                PENDING_EXIT_REASON=""

                log_status "SUCCESS" "🏁 Graceful exit triggered: $exit_reason"
                reset_session "project_complete"
                update_status "$loop_count" "$(cat "$CALL_COUNT_FILE")" "graceful_exit" "completed" "$exit_reason"

                log_status "SUCCESS" "🎉 Ralph has completed the project! Final stats:"
                log_status "INFO" "  - Total loops: $loop_count"
                log_status "INFO" "  - API calls used: $(cat "$CALL_COUNT_FILE")"
                log_status "INFO" "  - Exit reason: $exit_reason"
                break
            fi

            update_status "$loop_count" "$(cat "$CALL_COUNT_FILE")" "completed" "success"

            # Consume review findings after successful execution — the AI has received
            # the context via --append-system-prompt. Deleting here (not in
            # build_review_context) ensures findings survive transient loop failures.
            rm -f "$REVIEW_FINDINGS_FILE"

            # Code review check
            local fix_plan_delta=0
            if [[ -f "$RESPONSE_ANALYSIS_FILE" ]]; then
                fix_plan_delta=$(jq -r '.analysis.fix_plan_completed_delta // 0' "$RESPONSE_ANALYSIS_FILE" 2>/dev/null || echo "0")
                [[ ! "$fix_plan_delta" =~ ^-?[0-9]+$ ]] && fix_plan_delta=0
            fi
            if should_run_review "$loop_count" "$fix_plan_delta"; then
                run_review_loop "$loop_count"
            fi

            # Brief pause between successful executions
            sleep 5
        elif [ $exec_result -eq 3 ]; then
            # Circuit breaker opened
            reset_session "circuit_breaker_trip"
            update_status "$loop_count" "$(cat "$CALL_COUNT_FILE")" "circuit_breaker_open" "halted" "stagnation_detected"
            log_status "ERROR" "🛑 Circuit breaker has opened - halting loop"
            log_status "INFO" "Run 'bash .ralph/ralph_loop.sh --reset-circuit' to reset the circuit breaker after addressing issues"
            break
        elif [ $exec_result -eq 2 ]; then
            # API 5-hour limit reached - handle specially
            update_status "$loop_count" "$(cat "$CALL_COUNT_FILE")" "api_limit" "paused"
            log_status "WARN" "🛑 Claude API 5-hour limit reached!"
            
            # Ask user whether to wait or exit
            echo -e "\n${YELLOW}The Claude API 5-hour usage limit has been reached.${NC}"
            echo -e "${YELLOW}You can either:${NC}"
            echo -e "  ${GREEN}1)${NC} Wait for the limit to reset (usually within an hour)"
            echo -e "  ${GREEN}2)${NC} Exit the loop and try again later"
            echo -e "\n${BLUE}Choose an option (1 or 2):${NC} "
            
            # Read user input with timeout
            read -t 30 -n 1 user_choice
            echo  # New line after input
            
            if [[ "$user_choice" == "2" ]] || [[ -z "$user_choice" ]]; then
                log_status "INFO" "User chose to exit (or timed out). Exiting loop..."
                update_status "$loop_count" "$(cat "$CALL_COUNT_FILE")" "api_limit_exit" "stopped" "api_5hour_limit"
                break
            else
                log_status "INFO" "User chose to wait. Waiting for API limit reset..."
                # Wait for longer period when API limit is hit
                local wait_minutes=60
                log_status "INFO" "Waiting $wait_minutes minutes before retrying..."
                
                # Countdown display
                local wait_seconds=$((wait_minutes * 60))
                while [[ $wait_seconds -gt 0 ]]; do
                    local minutes=$((wait_seconds / 60))
                    local seconds=$((wait_seconds % 60))
                    printf "\r${YELLOW}Time until retry: %02d:%02d${NC}" $minutes $seconds
                    sleep 1
                    ((wait_seconds--))
                done
                printf "\n"
            fi
        else
            # Infrastructure failures (timeout, crash, OOM) intentionally bypass
            # record_loop_result to avoid counting as agent stagnation. The circuit
            # breaker only tracks progress during successful executions. (Issue #145)
            local exit_desc
            exit_desc=$(describe_exit_code "${LAST_DRIVER_EXIT_CODE:-1}")
            update_status "$loop_count" "$(cat "$CALL_COUNT_FILE")" "failed" "error" "$exit_desc" "${LAST_DRIVER_EXIT_CODE:-}"
            log_status "WARN" "Execution failed, waiting 30 seconds before retry..."
            sleep 30
        fi
        
        log_status "LOOP" "=== Completed Loop #$loop_count ==="
    done
}

# Help function
show_help() {
    cat << HELPEOF
Ralph Loop

Usage: $0 [OPTIONS]

IMPORTANT: This command must be run from a bmalph/Ralph project directory.
           Use 'bmalph init' in your project first.

Options:
    -h, --help              Show this help message
    -c, --calls NUM         Set max calls per hour (default: $MAX_CALLS_PER_HOUR)
    -p, --prompt FILE       Set prompt file (default: $PROMPT_FILE)
    -s, --status            Show current status and exit
    -m, --monitor           Start with tmux session and live monitor (requires tmux)
    -v, --verbose           Show detailed progress updates during execution
    -l, --live              Show live driver output in real-time (auto-switches to JSON output)
    -t, --timeout MIN       Set driver execution timeout in minutes (default: $CLAUDE_TIMEOUT_MINUTES)
    --reset-circuit         Reset circuit breaker to CLOSED state
    --circuit-status        Show circuit breaker status and exit
    --auto-reset-circuit    Auto-reset circuit breaker on startup (bypasses cooldown)
    --reset-session         Reset session state and exit (clears session continuity)

Modern CLI Options (Phase 1.1):
    --output-format FORMAT  Set driver output format: json or text (default: $CLAUDE_OUTPUT_FORMAT)
                            Note: --live mode requires JSON and will auto-switch
    --allowed-tools TOOLS   Claude Code only. Ignored by codex, opencode, cursor, and copilot
    --no-continue           Disable session continuity across loops
    --session-expiry HOURS  Set session expiration time in hours (default: $CLAUDE_SESSION_EXPIRY_HOURS)

Files created:
    - $LOG_DIR/: All execution logs
    - $DOCS_DIR/: Generated documentation
    - $STATUS_FILE: Current status (JSON)
    - .ralph/.ralph_session: Session lifecycle tracking
    - .ralph/.ralph_session_history: Session transition history (last 50)
    - .ralph/.call_count: API call counter for rate limiting
    - .ralph/.last_reset: Timestamp of last rate limit reset

Example workflow:
    cd my-project              # Enter project directory
    bmalph init                # Install bmalph + Ralph files
    bmalph implement           # Generate Ralph task files
    $0 --monitor               # Start Ralph with monitoring

Examples:
    bmalph run                 # Start Ralph via the bmalph CLI
    $0 --calls 50 --prompt my_prompt.md
    $0 --monitor               # Start with integrated tmux monitoring
    $0 --live                  # Show live driver output in real-time (streaming)
    $0 --live --verbose        # Live streaming + verbose logging
    $0 --monitor --timeout 30   # 30-minute timeout for complex tasks
    $0 --verbose --timeout 5    # 5-minute timeout with detailed progress
    $0 --output-format text     # Use legacy text output format
    $0 --no-continue            # Disable session continuity
    $0 --session-expiry 48      # 48-hour session expiration

HELPEOF
}

# Only parse arguments and run main when executed directly, not when sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        -c|--calls)
            MAX_CALLS_PER_HOUR="$2"
            _cli_MAX_CALLS_PER_HOUR="$MAX_CALLS_PER_HOUR"
            _CLI_MAX_CALLS_PER_HOUR=true
            shift 2
            ;;
        -p|--prompt)
            PROMPT_FILE="$2"
            shift 2
            ;;
        -s|--status)
            if [[ -f "$STATUS_FILE" ]]; then
                echo "Current Status:"
                cat "$STATUS_FILE" | jq . 2>/dev/null || cat "$STATUS_FILE"
            else
                echo "No status file found. Ralph may not be running."
            fi
            exit 0
            ;;
        -m|--monitor)
            USE_TMUX=true
            shift
            ;;
        -v|--verbose)
            VERBOSE_PROGRESS=true
            _cli_VERBOSE_PROGRESS="$VERBOSE_PROGRESS"
            _CLI_VERBOSE_PROGRESS=true
            shift
            ;;
        -l|--live)
            LIVE_OUTPUT=true
            shift
            ;;
        -t|--timeout)
            if [[ "$2" =~ ^[1-9][0-9]*$ ]] && [[ "$2" -le 120 ]]; then
                CLAUDE_TIMEOUT_MINUTES="$2"
                _cli_CLAUDE_TIMEOUT_MINUTES="$CLAUDE_TIMEOUT_MINUTES"
                _CLI_CLAUDE_TIMEOUT_MINUTES=true
            else
                echo "Error: Timeout must be a positive integer between 1 and 120 minutes"
                exit 1
            fi
            shift 2
            ;;
        --reset-circuit)
            # Source the circuit breaker library
            SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
            source "$SCRIPT_DIR/lib/circuit_breaker.sh"
            source "$SCRIPT_DIR/lib/date_utils.sh"
            reset_circuit_breaker "Manual reset via command line"
            reset_session "manual_circuit_reset"
            exit 0
            ;;
        --reset-session)
            # Reset session state only
            SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
            source "$SCRIPT_DIR/lib/date_utils.sh"
            reset_session "manual_reset_flag"
            echo -e "\033[0;32m✅ Session state reset successfully\033[0m"
            exit 0
            ;;
        --circuit-status)
            # Source the circuit breaker library
            SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
            source "$SCRIPT_DIR/lib/circuit_breaker.sh"
            show_circuit_status
            exit 0
            ;;
        --output-format)
            if [[ "$2" == "json" || "$2" == "text" ]]; then
                CLAUDE_OUTPUT_FORMAT="$2"
                _cli_CLAUDE_OUTPUT_FORMAT="$CLAUDE_OUTPUT_FORMAT"
                _CLI_CLAUDE_OUTPUT_FORMAT=true
            else
                echo "Error: --output-format must be 'json' or 'text'"
                exit 1
            fi
            shift 2
            ;;
        --allowed-tools)
            CLAUDE_ALLOWED_TOOLS="$2"
            _cli_CLAUDE_ALLOWED_TOOLS="$2"
            _CLI_ALLOWED_TOOLS=true
            shift 2
            ;;
        --no-continue)
            CLAUDE_USE_CONTINUE=false
            _cli_CLAUDE_USE_CONTINUE="$CLAUDE_USE_CONTINUE"
            _CLI_SESSION_CONTINUITY=true
            shift
            ;;
        --session-expiry)
            if [[ -z "$2" || ! "$2" =~ ^[1-9][0-9]*$ ]]; then
                echo "Error: --session-expiry requires a positive integer (hours)"
                exit 1
            fi
            CLAUDE_SESSION_EXPIRY_HOURS="$2"
            _cli_CLAUDE_SESSION_EXPIRY_HOURS="$2"
            _CLI_SESSION_EXPIRY_HOURS=true
            shift 2
            ;;
        --auto-reset-circuit)
            CB_AUTO_RESET=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# If tmux mode requested, set it up
if [[ "$USE_TMUX" == "true" ]]; then
    check_tmux_available
    setup_tmux_session
fi

# Start the main loop
main

fi  # end: BASH_SOURCE[0] == $0
