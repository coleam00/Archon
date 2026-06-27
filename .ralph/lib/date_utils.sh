#!/usr/bin/env bash

# date_utils.sh - Cross-platform date utility functions
# Provides consistent date formatting and arithmetic across GNU (Linux) and BSD (macOS) systems

# Get current timestamp in ISO 8601 format with seconds precision
# Returns: YYYY-MM-DDTHH:MM:SS+00:00 format
# Uses capability detection instead of uname to handle macOS with Homebrew coreutils
get_iso_timestamp() {
    # Try GNU date first (works on Linux and macOS with Homebrew coreutils)
    local result
    if result=$(date -u -Iseconds 2>/dev/null) && [[ -n "$result" ]]; then
        echo "$result"
        return
    fi
    # Fallback to BSD date (native macOS) - add colon to timezone offset
    date -u +"%Y-%m-%dT%H:%M:%S%z" | sed 's/\(..\)$/:\1/'
}

# Get time component (HH:MM:SS) for one hour from now
# Returns: HH:MM:SS format
# Uses capability detection instead of uname to handle macOS with Homebrew coreutils
get_next_hour_time() {
    # Try GNU date first (works on Linux and macOS with Homebrew coreutils)
    if date -d '+1 hour' '+%H:%M:%S' 2>/dev/null; then
        return
    fi
    # Fallback to BSD date (native macOS)
    if date -v+1H '+%H:%M:%S' 2>/dev/null; then
        return
    fi
    # Ultimate fallback - compute using epoch arithmetic
    local future_epoch=$(($(date +%s) + 3600))
    date -r "$future_epoch" '+%H:%M:%S' 2>/dev/null || date '+%H:%M:%S'
}

# Get current timestamp in a basic format (fallback)
# Returns: YYYY-MM-DD HH:MM:SS format
get_basic_timestamp() {
    date '+%Y-%m-%d %H:%M:%S'
}

# Get current Unix epoch time in seconds
# Returns: Integer seconds since 1970-01-01 00:00:00 UTC
get_epoch_seconds() {
    date +%s
}

# Convert ISO 8601 timestamp to Unix epoch seconds
# Input: ISO timestamp (e.g., "2025-01-15T10:30:00+00:00")
# Returns: Unix epoch seconds on stdout
# Returns non-zero on parse failure.
parse_iso_to_epoch_strict() {
    local iso_timestamp=$1

    if [[ -z "$iso_timestamp" || "$iso_timestamp" == "null" ]]; then
        return 1
    fi

    local normalized_iso
    normalized_iso=$(printf '%s' "$iso_timestamp" | sed -E 's/\.([0-9]+)(Z|[+-][0-9]{2}:[0-9]{2})$/\2/')

    # Try GNU date -d (Linux, macOS with Homebrew coreutils)
    local result
    if result=$(date -d "$iso_timestamp" +%s 2>/dev/null) && [[ "$result" =~ ^[0-9]+$ ]]; then
        echo "$result"
        return 0
    fi

    # Try BSD date -j (native macOS)
    # Normalize timezone for BSD parsing (Z → +0000, ±HH:MM → ±HHMM)
    local tz_fixed
    tz_fixed=$(printf '%s' "$normalized_iso" | sed -E 's/Z$/+0000/; s/([+-][0-9]{2}):([0-9]{2})$/\1\2/')
    if result=$(date -j -f "%Y-%m-%dT%H:%M:%S%z" "$tz_fixed" +%s 2>/dev/null) && [[ "$result" =~ ^[0-9]+$ ]]; then
        echo "$result"
        return 0
    fi

    # Fallback: manual epoch arithmetic from ISO components
    # Parse: YYYY-MM-DDTHH:MM:SS (ignore timezone, assume UTC)
    local year month day hour minute second
    if [[ "$normalized_iso" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2}) ]]; then
        year="${BASH_REMATCH[1]}"
        month="${BASH_REMATCH[2]}"
        day="${BASH_REMATCH[3]}"
        hour="${BASH_REMATCH[4]}"
        minute="${BASH_REMATCH[5]}"
        second="${BASH_REMATCH[6]}"

        # Use date with explicit components if available
        if result=$(date -u -d "${year}-${month}-${day} ${hour}:${minute}:${second}" +%s 2>/dev/null) && [[ "$result" =~ ^[0-9]+$ ]]; then
            echo "$result"
            return 0
        fi
    fi

    return 1
}

# Convert ISO 8601 timestamp to Unix epoch seconds
# Input: ISO timestamp (e.g., "2025-01-15T10:30:00+00:00")
# Returns: Unix epoch seconds on stdout
# Falls back to current epoch on parse failure (safe default)
parse_iso_to_epoch() {
    local iso_timestamp=$1
    local result

    if result=$(parse_iso_to_epoch_strict "$iso_timestamp"); then
        echo "$result"
        return 0
    fi

    # Ultimate fallback: return current epoch (safe default)
    date +%s
}

# Export functions for use in other scripts
export -f get_iso_timestamp
export -f get_next_hour_time
export -f get_basic_timestamp
export -f get_epoch_seconds
export -f parse_iso_to_epoch_strict
export -f parse_iso_to_epoch
