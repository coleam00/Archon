#!/usr/bin/env bash

# timeout_utils.sh - Cross-platform timeout utility functions
# Provides consistent timeout command execution across GNU (Linux) and BSD (macOS) systems
#
# On Linux: Uses the built-in GNU `timeout` command from coreutils
# On macOS: Uses `gtimeout` from Homebrew coreutils, or falls back to `timeout` if available

# Cached timeout command to avoid repeated detection
export _TIMEOUT_CMD=""

# Detect the available timeout command for this platform
# Sets _TIMEOUT_CMD to the appropriate command
# Returns 0 if a timeout command is available, 1 if not
detect_timeout_command() {
    # Return cached result if already detected
    if [[ -n "$_TIMEOUT_CMD" ]]; then
        echo "$_TIMEOUT_CMD"
        return 0
    fi

    local os_type
    os_type=$(uname)

    if [[ "$os_type" == "Darwin" ]]; then
        # macOS: Check for gtimeout (from Homebrew coreutils) first
        if command -v gtimeout &> /dev/null; then
            _TIMEOUT_CMD="gtimeout"
        elif command -v timeout &> /dev/null; then
            # Some macOS setups might have timeout available (e.g., MacPorts)
            _TIMEOUT_CMD="timeout"
        else
            # No timeout command available
            _TIMEOUT_CMD=""
            return 1
        fi
    else
        # Linux and other Unix systems: use standard timeout
        if command -v timeout &> /dev/null; then
            _TIMEOUT_CMD="timeout"
        else
            # Timeout not found (unusual on Linux)
            _TIMEOUT_CMD=""
            return 1
        fi
    fi

    echo "$_TIMEOUT_CMD"
    return 0
}

# Check if a timeout command is available on this system
# Returns 0 if available, 1 if not
has_timeout_command() {
    local cmd
    cmd=$(detect_timeout_command 2>/dev/null)
    [[ -n "$cmd" ]]
}

# Get a user-friendly message about timeout availability
# Useful for error messages and installation instructions
get_timeout_status_message() {
    local os_type
    os_type=$(uname)

    if has_timeout_command; then
        local cmd
        cmd=$(detect_timeout_command)
        echo "Timeout command available: $cmd"
        return 0
    fi

    if [[ "$os_type" == "Darwin" ]]; then
        echo "Timeout command not found. Install GNU coreutils: brew install coreutils"
    else
        echo "Timeout command not found. Install coreutils: sudo apt-get install coreutils"
    fi
    return 1
}

# Execute a command with a timeout (cross-platform)
# Usage: portable_timeout DURATION COMMAND [ARGS...]
#
# Arguments:
#   DURATION  - Timeout duration (e.g., "30s", "5m", "1h")
#   COMMAND   - The command to execute
#   ARGS      - Additional arguments for the command
#
# Returns:
#   0   - Command completed successfully within timeout
#   124 - Command timed out (GNU timeout behavior)
#   1   - No timeout command available (logs error)
#   *   - Exit code from the executed command
#
# Example:
#   portable_timeout 30s curl -s https://example.com
#   portable_timeout 5m npm install
#
portable_timeout() {
    local duration=$1
    shift

    # Validate arguments
    if [[ -z "$duration" ]]; then
        echo "Error: portable_timeout requires a duration argument" >&2
        return 1
    fi

    if [[ $# -eq 0 ]]; then
        echo "Error: portable_timeout requires a command to execute" >&2
        return 1
    fi

    # Detect the timeout command
    local timeout_cmd
    timeout_cmd=$(detect_timeout_command 2>/dev/null)

    if [[ -z "$timeout_cmd" ]]; then
        local os_type
        os_type=$(uname)

        echo "Error: No timeout command available on this system" >&2
        if [[ "$os_type" == "Darwin" ]]; then
            echo "Install GNU coreutils on macOS: brew install coreutils" >&2
        else
            echo "Install coreutils: sudo apt-get install coreutils" >&2
        fi
        return 1
    fi

    # Execute the command with timeout
    "$timeout_cmd" "$duration" "$@"
}

# Reset the cached timeout command (useful for testing)
reset_timeout_detection() {
    _TIMEOUT_CMD=""
}

# Export functions for use in other scripts
export -f detect_timeout_command
export -f has_timeout_command
export -f get_timeout_status_message
export -f portable_timeout
export -f reset_timeout_detection
