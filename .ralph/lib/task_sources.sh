#!/usr/bin/env bash

# task_sources.sh - Task import utilities for Ralph enable
# Supports importing tasks from beads, GitHub Issues, and PRD files

# =============================================================================
# BEADS INTEGRATION
# =============================================================================

# check_beads_available - Check if beads (bd) is available and configured
#
# Returns:
#   0 - Beads available
#   1 - Beads not available or not configured
#
check_beads_available() {
    # Check for .beads directory
    if [[ ! -d ".beads" ]]; then
        return 1
    fi

    # Check if bd command exists
    if ! command -v bd &>/dev/null; then
        return 1
    fi

    return 0
}

# fetch_beads_tasks - Fetch tasks from beads issue tracker
#
# Parameters:
#   $1 (filterStatus) - Status filter (optional, default: "open")
#
# Outputs:
#   Tasks in markdown checkbox format, one per line
#   e.g., "- [ ] [issue-001] Fix authentication bug"
#
# Returns:
#   0 - Success (may output empty if no tasks)
#   1 - Error fetching tasks
#
fetch_beads_tasks() {
    local filterStatus="${1:-open}"
    local tasks=""

    # Check if beads is available
    if ! check_beads_available; then
        return 1
    fi

    # Build bd list command arguments
    local bdArgs=("list" "--json")
    if [[ "$filterStatus" == "open" ]]; then
        bdArgs+=("--status" "open")
    elif [[ "$filterStatus" == "in_progress" ]]; then
        bdArgs+=("--status" "in_progress")
    elif [[ "$filterStatus" == "all" ]]; then
        bdArgs+=("--all")
    fi

    # Try to get tasks as JSON
    local json_output
    if json_output=$(bd "${bdArgs[@]}" 2>/dev/null); then
        # Parse JSON and format as markdown tasks
        # Note: Use 'select(.status == "closed") | not' to avoid bash escaping issues with '!='
        # Also filter out entries with missing id or title fields
        if command -v jq &>/dev/null; then
            tasks=$(echo "$json_output" | jq -r '
                .[] |
                select(.status == "closed" | not) |
                select((.id // "") != "" and (.title // "") != "") |
                "- [ ] [\(.id)] \(.title)"
            ' 2>/dev/null || echo "")
        fi
    fi

    # Fallback: try plain text output if JSON failed or produced no results
    if [[ -z "$tasks" ]]; then
        # Build fallback args (reuse status logic, but without --json)
        local fallbackArgs=("list")
        if [[ "$filterStatus" == "open" ]]; then
            fallbackArgs+=("--status" "open")
        elif [[ "$filterStatus" == "in_progress" ]]; then
            fallbackArgs+=("--status" "in_progress")
        elif [[ "$filterStatus" == "all" ]]; then
            fallbackArgs+=("--all")
        fi
        tasks=$(bd "${fallbackArgs[@]}" 2>/dev/null | while IFS= read -r line; do
            # Extract ID and title from bd list output
            # Format: "○ cnzb-xxx [● P2] [task] - Title here"
            local id title
            id=$(echo "$line" | grep -oE '[a-z]+-[a-z0-9]+' | head -1 || echo "")
            # Extract title after the last " - " separator
            title=$(echo "$line" | sed 's/.*- //' || echo "$line")
            if [[ -n "$id" && -n "$title" ]]; then
                echo "- [ ] [$id] $title"
            fi
        done)
    fi

    if [[ -n "$tasks" ]]; then
        echo "$tasks"
        return 0
    else
        return 0  # Empty is not an error
    fi
}

# get_beads_count - Get count of open beads issues
#
# Returns:
#   0 and echoes the count
#   1 if beads unavailable
#
get_beads_count() {
    if ! check_beads_available; then
        echo "0"
        return 1
    fi

    local count
    if command -v jq &>/dev/null; then
        # Note: Use 'select(.status == "closed" | not)' to avoid bash escaping issues with '!='
        count=$(bd list --json 2>/dev/null | jq '[.[] | select(.status == "closed" | not)] | length' 2>/dev/null || echo "0")
    else
        count=$(bd list 2>/dev/null | wc -l | tr -d ' ')
    fi

    echo "${count:-0}"
    return 0
}

# =============================================================================
# GITHUB ISSUES INTEGRATION
# =============================================================================

# check_github_available - Check if GitHub CLI (gh) is available and authenticated
#
# Returns:
#   0 - GitHub available and authenticated
#   1 - Not available
#
check_github_available() {
    # Check for gh command
    if ! command -v gh &>/dev/null; then
        return 1
    fi

    # Check if authenticated
    if ! gh auth status &>/dev/null; then
        return 1
    fi

    # Check if in a git repo with GitHub remote
    if ! git remote get-url origin 2>/dev/null | grep -q "github.com"; then
        return 1
    fi

    return 0
}

# fetch_github_tasks - Fetch issues from GitHub
#
# Parameters:
#   $1 (label) - Label to filter by (optional, default: "ralph-task")
#   $2 (limit) - Maximum number of issues (optional, default: 50)
#
# Outputs:
#   Tasks in markdown checkbox format
#   e.g., "- [ ] [#123] Implement user authentication"
#
# Returns:
#   0 - Success
#   1 - Error
#
fetch_github_tasks() {
    local label="${1:-}"
    local limit="${2:-50}"
    local tasks=""

    # Check if GitHub is available
    if ! check_github_available; then
        return 1
    fi

    # Build gh command
    local gh_args=("issue" "list" "--state" "open" "--limit" "$limit" "--json" "number,title,labels")
    if [[ -n "$label" ]]; then
        gh_args+=("--label" "$label")
    fi

    # Fetch issues
    local json_output
    if ! json_output=$(gh "${gh_args[@]}" 2>/dev/null); then
        return 1
    fi

    # Parse JSON and format as markdown tasks
    if command -v jq &>/dev/null; then
        tasks=$(echo "$json_output" | jq -r '
            .[] |
            "- [ ] [#\(.number)] \(.title)"
        ' 2>/dev/null)
    fi

    if [[ -n "$tasks" ]]; then
        echo "$tasks"
    fi

    return 0
}

# get_github_issue_count - Get count of open GitHub issues
#
# Parameters:
#   $1 (label) - Label to filter by (optional)
#
# Returns:
#   0 and echoes the count
#   1 if GitHub unavailable
#
get_github_issue_count() {
    local label="${1:-}"

    if ! check_github_available; then
        echo "0"
        return 1
    fi

    local gh_args=("issue" "list" "--state" "open" "--json" "number")
    if [[ -n "$label" ]]; then
        gh_args+=("--label" "$label")
    fi

    local count
    if command -v jq &>/dev/null; then
        count=$(gh "${gh_args[@]}" 2>/dev/null | jq 'length' 2>/dev/null || echo "0")
    else
        count=$(gh issue list --state open 2>/dev/null | wc -l | tr -d ' ')
    fi

    echo "${count:-0}"
    return 0
}

# get_github_labels - Get available labels from GitHub repo
#
# Outputs:
#   Newline-separated list of label names
#
get_github_labels() {
    if ! check_github_available; then
        return 1
    fi

    gh label list --json name --jq '.[].name' 2>/dev/null
}

# =============================================================================
# PRD CONVERSION
# =============================================================================

# extract_prd_tasks - Extract tasks from a PRD/specification document
#
# Parameters:
#   $1 (prd_file) - Path to the PRD file
#
# Outputs:
#   Tasks in markdown checkbox format
#
# Returns:
#   0 - Success
#   1 - Error
#
# Note: For full PRD conversion with Claude, use ralph-import
# This function does basic extraction without AI assistance
#
extract_prd_tasks() {
    local prd_file=$1

    if [[ ! -f "$prd_file" ]]; then
        return 1
    fi

    local tasks=""

    # Look for existing checkbox items
    local checkbox_tasks
    checkbox_tasks=$(grep -E '^[[:space:]]*[-*][[:space:]]*\[[[:space:]]*[xX ]?[[:space:]]*\]' "$prd_file" 2>/dev/null)
    if [[ -n "$checkbox_tasks" ]]; then
        # Normalize to unchecked format
        tasks=$(echo "$checkbox_tasks" | sed 's/\[x\]/[ ]/gi; s/\[X\]/[ ]/g')
    fi

    # Look for numbered list items that look like tasks
    local numbered_tasks
    numbered_tasks=$(grep -E '^[[:space:]]*[0-9]+\.[[:space:]]+' "$prd_file" 2>/dev/null | head -20)
    if [[ -n "$numbered_tasks" ]]; then
        while IFS= read -r line; do
            # Convert numbered item to checkbox
            local task_text
            task_text=$(echo "$line" | sed -E 's/^[[:space:]]*[0-9]*\.[[:space:]]*//')
            if [[ -n "$task_text" ]]; then
                tasks="${tasks}
- [ ] ${task_text}"
            fi
        done <<< "$numbered_tasks"
    fi

    # Look for headings that might be task sections (with line numbers to handle duplicates)
    local heading_lines
    heading_lines=$(grep -nE '^#{1,3}[[:space:]]+(TODO|Tasks|Requirements|Features|Backlog|Sprint)' "$prd_file" 2>/dev/null)
    if [[ -n "$heading_lines" ]]; then
        # Extract bullet items beneath each matching heading
        while IFS= read -r heading_entry; do
            # Parse line number directly from grep -n output (avoids duplicate heading issue)
            local heading_line
            heading_line=$(echo "$heading_entry" | cut -d: -f1)
            [[ -z "$heading_line" ]] && continue

            # Find the next heading (any level) after this one
            local next_heading_line
            next_heading_line=$(tail -n +"$((heading_line + 1))" "$prd_file" | grep -n '^#' | head -1 | cut -d: -f1)

            # Extract the section content
            local section_content
            if [[ -n "$next_heading_line" ]]; then
                local end_line=$((heading_line + next_heading_line - 1))
                section_content=$(sed -n "$((heading_line + 1)),${end_line}p" "$prd_file")
            else
                section_content=$(tail -n +"$((heading_line + 1))" "$prd_file")
            fi

            # Extract bullet items from section and convert to checkboxes
            while IFS= read -r line; do
                local task_text=""
                # Match "- item" or "* item" (but not checkboxes, already handled above)
                if [[ "$line" =~ ^[[:space:]]*[-*][[:space:]]+(.+)$ ]]; then
                    task_text="${BASH_REMATCH[1]}"
                    # Skip checkbox lines — they are handled by the earlier extraction
                    if [[ "$line" == *"["*"]"* ]]; then
                        task_text=""
                    fi
                # Match "N. item" numbered patterns
                elif [[ "$line" =~ ^[[:space:]]*[0-9]+\.[[:space:]]+(.+)$ ]]; then
                    task_text="${BASH_REMATCH[1]}"
                fi
                if [[ -n "$task_text" ]]; then
                    tasks="${tasks}
- [ ] ${task_text}"
                fi
            done <<< "$section_content"
        done <<< "$heading_lines"
    fi

    # Clean up and output
    if [[ -n "$tasks" ]]; then
        echo "$tasks" | grep -v '^$' | awk '!seen[$0]++' | head -30  # Deduplicate, limit to 30
        return 0
    fi

    return 0  # Empty is not an error
}

# convert_prd_with_claude - Full PRD conversion using Claude (calls ralph-import logic)
#
# Parameters:
#   $1 (prd_file) - Path to the PRD file
#   $2 (output_dir) - Directory to output converted files (optional, defaults to .ralph/)
#
# Outputs:
#   Sets CONVERTED_PROMPT_FILE, CONVERTED_FIX_PLAN_FILE, CONVERTED_SPECS_FILE
#
# Returns:
#   0 - Success
#   1 - Error
#
convert_prd_with_claude() {
    local prd_file=$1
    local output_dir="${2:-.ralph}"

    # This would call into ralph_import.sh's convert_prd function
    # For now, we do basic extraction
    # Full Claude-based conversion requires the import script

    if [[ ! -f "$prd_file" ]]; then
        return 1
    fi

    # Check if ralph-import is available for full conversion
    if command -v ralph-import &>/dev/null; then
        # Use ralph-import for full conversion
        # Note: ralph-import creates a new project, so we need to adapt
        echo "Full PRD conversion available via: ralph-import $prd_file"
        return 1  # Return error to indicate basic extraction should be used
    fi

    # Fall back to basic extraction
    extract_prd_tasks "$prd_file"
}

# =============================================================================
# TASK NORMALIZATION
# =============================================================================

# normalize_tasks - Normalize tasks to consistent markdown format
#
# Parameters:
#   $1 (tasks) - Raw task text (multi-line)
#   $2 (source) - Source identifier (beads, github, prd)
#
# Outputs:
#   Normalized tasks in markdown checkbox format
#
normalize_tasks() {
    local tasks=$1
    local source="${2:-unknown}"

    if [[ -z "$tasks" ]]; then
        return 0
    fi

    # Process each line
    echo "$tasks" | while IFS= read -r line; do
        # Skip empty lines
        [[ -z "$line" ]] && continue

        # Already in checkbox format
        if echo "$line" | grep -qE '^[[:space:]]*-[[:space:]]*\[[[:space:]]*[xX ]?[[:space:]]*\]'; then
            # Normalize the checkbox
            echo "$line" | sed 's/\[x\]/[ ]/gi; s/\[X\]/[ ]/g'
            continue
        fi

        # Bullet point without checkbox
        if echo "$line" | grep -qE '^[[:space:]]*[-*][[:space:]]+'; then
            local text
            text=$(echo "$line" | sed -E 's/^[[:space:]]*[-*][[:space:]]*//')
            echo "- [ ] $text"
            continue
        fi

        # Numbered item
        if echo "$line" | grep -qE '^[[:space:]]*[0-9]+\.?[[:space:]]+'; then
            local text
            text=$(echo "$line" | sed -E 's/^[[:space:]]*[0-9]*\.?[[:space:]]*//')
            echo "- [ ] $text"
            continue
        fi

        # Plain text line - make it a task
        echo "- [ ] $line"
    done
}

# prioritize_tasks - Sort tasks by priority heuristics
#
# Parameters:
#   $1 (tasks) - Tasks in markdown format
#
# Outputs:
#   Tasks sorted with priority indicators
#
# Heuristics:
#   - "critical", "urgent", "blocker" -> High priority
#   - "important", "should", "must" -> High priority
#   - "nice to have", "optional", "future" -> Low priority
#
prioritize_tasks() {
    local tasks=$1

    if [[ -z "$tasks" ]]; then
        return 0
    fi

    # Separate into priority buckets
    local high_priority=""
    local medium_priority=""
    local low_priority=""

    while IFS= read -r line; do
        [[ -z "$line" ]] && continue

        local lower_line
        lower_line=$(echo "$line" | tr '[:upper:]' '[:lower:]')

        # Check for priority indicators
        if echo "$lower_line" | grep -qE '(critical|urgent|blocker|breaking|security|p0|p1)'; then
            high_priority="${high_priority}${line}
"
        elif echo "$lower_line" | grep -qE '(nice.to.have|optional|future|later|p3|p4|low.priority)'; then
            low_priority="${low_priority}${line}
"
        elif echo "$lower_line" | grep -qE '(important|should|must|needed|required|p2)'; then
            high_priority="${high_priority}${line}
"
        else
            medium_priority="${medium_priority}${line}
"
        fi
    done <<< "$tasks"

    # Output in priority order
    echo "## High Priority"
    [[ -n "$high_priority" ]] && echo "$high_priority"

    echo ""
    echo "## Medium Priority"
    [[ -n "$medium_priority" ]] && echo "$medium_priority"

    echo ""
    echo "## Low Priority"
    [[ -n "$low_priority" ]] && echo "$low_priority"
}

# =============================================================================
# COMBINED IMPORT
# =============================================================================

# import_tasks_from_sources - Import tasks from multiple sources
#
# Parameters:
#   $1 (sources) - Space-separated list of sources: beads, github, prd
#   $2 (prd_file) - Path to PRD file (required if prd in sources)
#   $3 (github_label) - GitHub label filter (optional)
#
# Outputs:
#   Combined tasks in markdown format
#
# Returns:
#   0 - Success
#   1 - No tasks imported
#
import_tasks_from_sources() {
    local sources=$1
    local prd_file="${2:-}"
    local github_label="${3:-}"

    local all_tasks=""
    local source_count=0

    # Import from beads
    if echo "$sources" | grep -qw "beads"; then
        local beads_tasks
        if beads_tasks=$(fetch_beads_tasks); then
            if [[ -n "$beads_tasks" ]]; then
                all_tasks="${all_tasks}
# Tasks from beads
${beads_tasks}
"
                ((source_count++))
            fi
        fi
    fi

    # Import from GitHub
    if echo "$sources" | grep -qw "github"; then
        local github_tasks
        if github_tasks=$(fetch_github_tasks "$github_label"); then
            if [[ -n "$github_tasks" ]]; then
                all_tasks="${all_tasks}
# Tasks from GitHub
${github_tasks}
"
                ((source_count++))
            fi
        fi
    fi

    # Import from PRD
    if echo "$sources" | grep -qw "prd"; then
        if [[ -n "$prd_file" && -f "$prd_file" ]]; then
            local prd_tasks
            if prd_tasks=$(extract_prd_tasks "$prd_file"); then
                if [[ -n "$prd_tasks" ]]; then
                    all_tasks="${all_tasks}
# Tasks from PRD
${prd_tasks}
"
                    ((source_count++))
                fi
            fi
        fi
    fi

    if [[ -z "$all_tasks" ]]; then
        return 1
    fi

    # Normalize and output
    normalize_tasks "$all_tasks" "combined"
    return 0
}

# =============================================================================
# EXPORTS
# =============================================================================

export -f check_beads_available
export -f fetch_beads_tasks
export -f get_beads_count
export -f check_github_available
export -f fetch_github_tasks
export -f get_github_issue_count
export -f get_github_labels
export -f extract_prd_tasks
export -f convert_prd_with_claude
export -f normalize_tasks
export -f prioritize_tasks
export -f import_tasks_from_sources
