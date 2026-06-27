#!/bin/bash

# Ralph Import - Convert PRDs to Ralph format using Claude Code
# Version: 0.9.8 - Modern CLI support with JSON output parsing
#
# DEPRECATED: This script is from standalone Ralph and references `ralph-setup`
# which does not exist in bmalph. Use `bmalph implement` for PRD-to-Ralph
# transition instead. This file is bundled for backward compatibility only.
set -e

# Configuration
CLAUDE_CODE_CMD="claude"

# Platform driver support
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
PLATFORM_DRIVER="${PLATFORM_DRIVER:-claude-code}"

# Source platform driver if available
if [[ -f "$SCRIPT_DIR/drivers/${PLATFORM_DRIVER}.sh" ]]; then
    # shellcheck source=/dev/null
    source "$SCRIPT_DIR/drivers/${PLATFORM_DRIVER}.sh"
    CLAUDE_CODE_CMD="$(driver_cli_binary)"
fi

# Modern CLI Configuration (Phase 1.1)
# These flags enable structured JSON output and controlled file operations
CLAUDE_OUTPUT_FORMAT="json"
# Use bash array for proper quoting of each tool argument
declare -a CLAUDE_ALLOWED_TOOLS=('Read' 'Write' 'Bash(mkdir:*)' 'Bash(cp:*)')
CLAUDE_MIN_VERSION="2.0.76"  # Minimum version for modern CLI features

# Temporary file names
CONVERSION_OUTPUT_FILE=".ralph_conversion_output.json"
CONVERSION_PROMPT_FILE=".ralph_conversion_prompt.md"

# Global parsed conversion result variables
# Set by parse_conversion_response() when parsing JSON output from Claude CLI
declare PARSED_RESULT=""           # Result/summary text from Claude response
declare PARSED_SESSION_ID=""       # Session ID for potential continuation
declare PARSED_FILES_CHANGED=""    # Count of files changed
declare PARSED_HAS_ERRORS=""       # Boolean flag indicating errors occurred
declare PARSED_COMPLETION_STATUS="" # Completion status (complete/partial/failed)
declare PARSED_ERROR_MESSAGE=""    # Error message if conversion failed
declare PARSED_ERROR_CODE=""       # Error code if conversion failed
declare PARSED_FILES_CREATED=""    # JSON array of files created
declare PARSED_MISSING_FILES=""    # JSON array of files that should exist but don't

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    local level=$1
    local message=$2
    local color=""

    case $level in
        "INFO")  color=$BLUE ;;
        "WARN")  color=$YELLOW ;;
        "ERROR") color=$RED ;;
        "SUCCESS") color=$GREEN ;;
    esac

    echo -e "${color}[$(date '+%H:%M:%S')] [$level] $message${NC}"
}

# =============================================================================
# JSON OUTPUT FORMAT DETECTION AND PARSING
# =============================================================================

# detect_response_format - Detect whether file contains JSON or plain text output
#
# Parameters:
#   $1 (output_file) - Path to the file to inspect
#
# Returns:
#   Echoes "json" if file is non-empty, starts with { or [, and validates as JSON
#   Echoes "text" otherwise (empty file, non-JSON content, or invalid JSON)
#
# Dependencies:
#   - jq (used for JSON validation; if unavailable, falls back to "text")
#
detect_response_format() {
    local output_file=$1

    if [[ ! -f "$output_file" ]] || [[ ! -s "$output_file" ]]; then
        echo "text"
        return
    fi

    # Check if file starts with { or [ (JSON indicators)
    # Use grep to find first non-whitespace character (handles leading whitespace)
    local first_char=$(grep -m1 -o '[^[:space:]]' "$output_file" 2>/dev/null)

    if [[ "$first_char" != "{" && "$first_char" != "[" ]]; then
        echo "text"
        return
    fi

    # Validate as JSON using jq
    if command -v jq &>/dev/null && jq empty "$output_file" 2>/dev/null; then
        echo "json"
    else
        echo "text"
    fi
}

# parse_conversion_response - Parse JSON response and extract conversion status
#
# Parameters:
#   $1 (output_file) - Path to JSON file containing Claude CLI response
#
# Returns:
#   0 on success (valid JSON parsed)
#   1 on error (file not found, jq unavailable, or invalid JSON)
#
# Sets Global Variables:
#   PARSED_RESULT           - Result/summary text from response
#   PARSED_SESSION_ID       - Session ID for continuation
#   PARSED_FILES_CHANGED    - Count of files changed
#   PARSED_HAS_ERRORS       - "true"/"false" indicating errors
#   PARSED_COMPLETION_STATUS - Status: "complete", "partial", "failed", "unknown"
#   PARSED_ERROR_MESSAGE    - Error message if conversion failed
#   PARSED_ERROR_CODE       - Error code if conversion failed
#   PARSED_FILES_CREATED    - JSON array string of created files
#   PARSED_MISSING_FILES    - JSON array string of missing files
#
# Dependencies:
#   - jq (required for JSON parsing)
#
parse_conversion_response() {
    local output_file=$1

    if [[ ! -f "$output_file" ]]; then
        return 1
    fi

    # Check if jq is available
    if ! command -v jq &>/dev/null; then
        log "WARN" "jq not found, skipping JSON parsing"
        return 1
    fi

    # Validate JSON first
    if ! jq empty "$output_file" 2>/dev/null; then
        log "WARN" "Invalid JSON in output, falling back to text parsing"
        return 1
    fi

    # Extract fields from JSON response
    # Supports both flat format and Claude CLI format with metadata

    # Result/summary field
    PARSED_RESULT=$(jq -r '.result // .summary // ""' "$output_file" 2>/dev/null)

    # Session ID (for potential continuation)
    PARSED_SESSION_ID=$(jq -r '.sessionId // .session_id // ""' "$output_file" 2>/dev/null)

    # Files changed count
    PARSED_FILES_CHANGED=$(jq -r '.metadata.files_changed // .files_changed // 0' "$output_file" 2>/dev/null)

    # Has errors flag
    PARSED_HAS_ERRORS=$(jq -r '.metadata.has_errors // .has_errors // false' "$output_file" 2>/dev/null)

    # Completion status
    PARSED_COMPLETION_STATUS=$(jq -r '.metadata.completion_status // .completion_status // "unknown"' "$output_file" 2>/dev/null)

    # Error message (if any)
    PARSED_ERROR_MESSAGE=$(jq -r '.metadata.error_message // .error_message // ""' "$output_file" 2>/dev/null)

    # Error code (if any)
    PARSED_ERROR_CODE=$(jq -r '.metadata.error_code // .error_code // ""' "$output_file" 2>/dev/null)

    # Files created (as array)
    PARSED_FILES_CREATED=$(jq -r '.metadata.files_created // [] | @json' "$output_file" 2>/dev/null)

    # Missing files (as array)
    PARSED_MISSING_FILES=$(jq -r '.metadata.missing_files // [] | @json' "$output_file" 2>/dev/null)

    return 0
}

# check_claude_version - Verify Claude Code CLI version meets minimum requirements
#
# Checks if the installed Claude Code CLI version is at or above CLAUDE_MIN_VERSION.
# Uses numeric semantic version comparison (major.minor.patch).
#
# Parameters:
#   None (uses global CLAUDE_CODE_CMD and CLAUDE_MIN_VERSION)
#
# Returns:
#   0 if version is >= CLAUDE_MIN_VERSION
#   1 if version cannot be determined or is below CLAUDE_MIN_VERSION
#
# Side Effects:
#   Logs warning via log() if version check fails
#
check_claude_version() {
    local version
    version=$($CLAUDE_CODE_CMD --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)

    if [[ -z "$version" ]]; then
        log "WARN" "Could not determine Claude Code CLI version"
        return 1
    fi

    # Numeric semantic version comparison
    # Split versions into major.minor.patch components
    local ver_major ver_minor ver_patch
    local min_major min_minor min_patch

    IFS='.' read -r ver_major ver_minor ver_patch <<< "$version"
    IFS='.' read -r min_major min_minor min_patch <<< "$CLAUDE_MIN_VERSION"

    # Default empty components to 0 (handles versions like "2.1" without patch)
    ver_major=${ver_major:-0}
    ver_minor=${ver_minor:-0}
    ver_patch=${ver_patch:-0}
    min_major=${min_major:-0}
    min_minor=${min_minor:-0}
    min_patch=${min_patch:-0}

    # Compare major version
    if [[ $ver_major -lt $min_major ]]; then
        log "WARN" "Claude Code CLI version $version is below recommended $CLAUDE_MIN_VERSION"
        return 1
    elif [[ $ver_major -gt $min_major ]]; then
        return 0
    fi

    # Major equal, compare minor version
    if [[ $ver_minor -lt $min_minor ]]; then
        log "WARN" "Claude Code CLI version $version is below recommended $CLAUDE_MIN_VERSION"
        return 1
    elif [[ $ver_minor -gt $min_minor ]]; then
        return 0
    fi

    # Minor equal, compare patch version
    if [[ $ver_patch -lt $min_patch ]]; then
        log "WARN" "Claude Code CLI version $version is below recommended $CLAUDE_MIN_VERSION"
        return 1
    fi

    return 0
}

show_help() {
    cat << HELPEOF
Ralph Import - Convert PRDs to Ralph Format

Usage: $0 <source-file> [project-name]

Arguments:
    source-file     Path to your PRD/specification file (any format)
    project-name    Name for the new Ralph project (optional, defaults to filename)

Examples:
    $0 my-app-prd.md
    $0 requirements.txt my-awesome-app
    $0 project-spec.json
    $0 design-doc.docx webapp

Supported formats:
    - Markdown (.md)
    - Text files (.txt)
    - JSON (.json)
    - Word documents (.docx)
    - PDFs (.pdf)
    - Any text-based format

This legacy helper is kept for standalone Ralph compatibility.
If you are using bmalph, use `bmalph implement` instead.

The command will:
1. Create a new Ralph project
2. Use Claude Code to intelligently convert your PRD into:
   - .ralph/PROMPT.md (Ralph instructions)
   - .ralph/@fix_plan.md (prioritized tasks)
   - .ralph/specs/ (technical specifications)

HELPEOF
}

# Check dependencies
check_dependencies() {
    if ! command -v ralph-setup &> /dev/null; then
        log "WARN" "ralph-setup not found. If using bmalph, run 'bmalph init' instead."
        log "WARN" "This script is deprecated — use 'bmalph implement' for PRD conversion."
        return 1
    fi

    if ! command -v jq &> /dev/null; then
        log "WARN" "jq not found. Install it (brew install jq | sudo apt-get install jq | choco install jq) for faster JSON parsing."
    fi

    if ! command -v "$CLAUDE_CODE_CMD" &> /dev/null 2>&1; then
        log "WARN" "Claude Code CLI ($CLAUDE_CODE_CMD) not found. It will be downloaded when first used."
    fi
}

# Convert PRD using Claude Code
convert_prd() {
    local source_file=$1
    local project_name=$2
    local use_modern_cli=true
    local cli_exit_code=0

    log "INFO" "Converting PRD to Ralph format using Claude Code..."

    # Check for modern CLI support
    if ! check_claude_version 2>/dev/null; then
        log "INFO" "Using standard CLI mode (modern features may not be available)"
        use_modern_cli=false
    else
        log "INFO" "Using modern CLI with JSON output format"
    fi

    # Create conversion prompt
    cat > "$CONVERSION_PROMPT_FILE" << 'PROMPTEOF'
# PRD to Ralph Conversion Task

You are tasked with converting a Product Requirements Document (PRD) or specification into Ralph's autonomous implementation format.

## Input Analysis
Analyze the provided specification file and extract:
- Project goals and objectives
- Core features and requirements
- Technical constraints and preferences
- Priority levels and phases
- Success criteria

## Required Outputs

Create these files in the .ralph/ subdirectory:

### 1. .ralph/PROMPT.md
Transform the PRD into Ralph development instructions:
```markdown
# Ralph Development Instructions

## Context
You are Ralph, an autonomous AI development agent working on a [PROJECT NAME] project.

## Current Objectives
[Extract and prioritize 4-6 main objectives from the PRD]

## Key Principles
- ONE task per loop - focus on the most important thing
- Search the codebase before assuming something isn't implemented
- Use subagents for expensive operations (file searching, analysis)
- Write comprehensive tests with clear documentation
- Toggle completed story checkboxes in @fix_plan.md without rewriting story lines
- Commit working changes with descriptive messages

## Progress Tracking (CRITICAL)
- Ralph tracks progress by counting story checkboxes in @fix_plan.md
- When you complete a story, change `- [ ]` to `- [x]` on that exact story line
- Do NOT remove, rewrite, or reorder story lines in @fix_plan.md
- Update the checkbox before committing so the monitor updates immediately
- Set `TASKS_COMPLETED_THIS_LOOP` to the exact number of story checkboxes toggled this loop
- Only valid values: 0 or 1

## 🧪 Testing Guidelines (CRITICAL)
- LIMIT testing to ~20% of your total effort per loop
- PRIORITIZE: Implementation > Documentation > Tests
- Only write tests for NEW functionality you implement
- Do NOT refactor existing tests unless broken
- Focus on CORE functionality first, comprehensive testing later

## Project Requirements
[Convert PRD requirements into clear, actionable development requirements]

## Technical Constraints
[Extract any technical preferences, frameworks, languages mentioned]

## Success Criteria
[Define what "done" looks like based on the PRD]

## Current Task
Follow @fix_plan.md and choose the most important item to implement next.
```

### 2. .ralph/@fix_plan.md
Convert requirements into a prioritized task list:
```markdown
# Ralph Fix Plan

## High Priority
[Extract and convert critical features into actionable tasks]

## Medium Priority
[Secondary features and enhancements]

## Low Priority
[Nice-to-have features and optimizations]

## Completed
- [x] Project initialization

## Notes
[Any important context from the original PRD]
```

### 3. .ralph/specs/requirements.md
Create detailed technical specifications:
```markdown
# Technical Specifications

[Convert PRD into detailed technical requirements including:]
- System architecture requirements
- Data models and structures
- API specifications
- User interface requirements
- Performance requirements
- Security considerations
- Integration requirements

[Preserve all technical details from the original PRD]
```

## Instructions
1. Read and analyze the attached specification file
2. Create the three files above with content derived from the PRD
3. Ensure all requirements are captured and properly prioritized
4. Make the PROMPT.md actionable for autonomous development
5. Structure @fix_plan.md with clear, implementable tasks

PROMPTEOF

    # Append the PRD source content to the conversion prompt
    local source_basename
    source_basename=$(basename "$source_file")
    
    if [[ -f "$source_file" ]]; then
        echo "" >> "$CONVERSION_PROMPT_FILE"
        echo "---" >> "$CONVERSION_PROMPT_FILE"
        echo "" >> "$CONVERSION_PROMPT_FILE"
        echo "## Source PRD File: $source_basename" >> "$CONVERSION_PROMPT_FILE"
        echo "" >> "$CONVERSION_PROMPT_FILE"
        cat "$source_file" >> "$CONVERSION_PROMPT_FILE"
    else
        log "ERROR" "Source file not found: $source_file"
        rm -f "$CONVERSION_PROMPT_FILE"
        exit 1
    fi

    # Build and execute Claude Code command
    # Modern CLI: Use --output-format json and --allowedTools for structured output
    # Fallback: Standard CLI invocation for older versions
    # Note: stderr is written to separate file to avoid corrupting JSON output
    local stderr_file="${CONVERSION_OUTPUT_FILE}.err"

    if [[ "$use_modern_cli" == "true" ]]; then
        # Modern CLI invocation with JSON output and controlled tool permissions
        # --print: Required for piped input (prevents interactive session hang)
        # --allowedTools: Permits file operations without user prompts
        # --strict-mcp-config: Skip loading user MCP servers (faster startup)
        if $CLAUDE_CODE_CMD --print --strict-mcp-config --output-format "$CLAUDE_OUTPUT_FORMAT" --allowedTools "${CLAUDE_ALLOWED_TOOLS[@]}" < "$CONVERSION_PROMPT_FILE" > "$CONVERSION_OUTPUT_FILE" 2> "$stderr_file"; then
            cli_exit_code=0
        else
            cli_exit_code=$?
        fi
    else
        # Standard CLI invocation (backward compatible)
        # --print: Required for piped input (prevents interactive session hang)
        if $CLAUDE_CODE_CMD --print < "$CONVERSION_PROMPT_FILE" > "$CONVERSION_OUTPUT_FILE" 2> "$stderr_file"; then
            cli_exit_code=0
        else
            cli_exit_code=$?
        fi
    fi

    # Log stderr if there was any (for debugging)
    if [[ -s "$stderr_file" ]]; then
        log "WARN" "CLI stderr output detected (see $stderr_file)"
    fi

    # Process the response
    local output_format="text"
    local json_parsed=false

    if [[ -f "$CONVERSION_OUTPUT_FILE" ]]; then
        output_format=$(detect_response_format "$CONVERSION_OUTPUT_FILE")

        if [[ "$output_format" == "json" ]]; then
            if parse_conversion_response "$CONVERSION_OUTPUT_FILE"; then
                json_parsed=true
                log "INFO" "Parsed JSON response from Claude CLI"

                # Check for errors in JSON response
                if [[ "$PARSED_HAS_ERRORS" == "true" && "$PARSED_COMPLETION_STATUS" == "failed" ]]; then
                    log "ERROR" "PRD conversion failed"
                    if [[ -n "$PARSED_ERROR_MESSAGE" ]]; then
                        log "ERROR" "Error: $PARSED_ERROR_MESSAGE"
                    fi
                    if [[ -n "$PARSED_ERROR_CODE" ]]; then
                        log "ERROR" "Error code: $PARSED_ERROR_CODE"
                    fi
                    rm -f "$CONVERSION_PROMPT_FILE" "$CONVERSION_OUTPUT_FILE" "$stderr_file"
                    exit 1
                fi

                # Log session ID if available (for potential continuation)
                if [[ -n "$PARSED_SESSION_ID" && "$PARSED_SESSION_ID" != "null" ]]; then
                    log "INFO" "Session ID: $PARSED_SESSION_ID"
                fi

                # Log files changed from metadata
                if [[ -n "$PARSED_FILES_CHANGED" && "$PARSED_FILES_CHANGED" != "0" ]]; then
                    log "INFO" "Files changed: $PARSED_FILES_CHANGED"
                fi
            fi
        fi
    fi

    # Check CLI exit code
    if [[ $cli_exit_code -ne 0 ]]; then
        log "ERROR" "PRD conversion failed (exit code: $cli_exit_code)"
        rm -f "$CONVERSION_PROMPT_FILE" "$CONVERSION_OUTPUT_FILE" "$stderr_file"
        exit 1
    fi

    # Use PARSED_RESULT for success message if available
    if [[ "$json_parsed" == "true" && -n "$PARSED_RESULT" && "$PARSED_RESULT" != "null" ]]; then
        log "SUCCESS" "PRD conversion completed: $PARSED_RESULT"
    else
        log "SUCCESS" "PRD conversion completed"
    fi

    # Clean up temp files
    rm -f "$CONVERSION_PROMPT_FILE" "$CONVERSION_OUTPUT_FILE" "$stderr_file"

    # Verify files were created
    # Use PARSED_FILES_CREATED from JSON if available, otherwise check filesystem
    local missing_files=()
    local created_files=()
    local expected_files=(".ralph/PROMPT.md" ".ralph/@fix_plan.md" ".ralph/specs/requirements.md")

    # If JSON provided files_created, use that to inform verification
    if [[ "$json_parsed" == "true" && -n "$PARSED_FILES_CREATED" && "$PARSED_FILES_CREATED" != "[]" ]]; then
        # Validate that PARSED_FILES_CREATED is a valid JSON array before iteration
        local is_array
        is_array=$(echo "$PARSED_FILES_CREATED" | jq -e 'type == "array"' 2>/dev/null)
        if [[ "$is_array" == "true" ]]; then
            # Parse JSON array and verify each file exists
            local json_files
            json_files=$(echo "$PARSED_FILES_CREATED" | jq -r '.[]' 2>/dev/null)
            if [[ -n "$json_files" ]]; then
                while IFS= read -r file; do
                    if [[ -n "$file" && -f "$file" ]]; then
                        created_files+=("$file")
                    elif [[ -n "$file" ]]; then
                        missing_files+=("$file")
                    fi
                done <<< "$json_files"
            fi
        fi
    fi

    # Always verify expected files exist (filesystem is source of truth)
    for file in "${expected_files[@]}"; do
        if [[ -f "$file" ]]; then
            # Add to created_files if not already there
            if [[ ! " ${created_files[*]} " =~ " ${file} " ]]; then
                created_files+=("$file")
            fi
        else
            # Add to missing_files if not already there
            if [[ ! " ${missing_files[*]} " =~ " ${file} " ]]; then
                missing_files+=("$file")
            fi
        fi
    done

    # Report created files
    if [[ ${#created_files[@]} -gt 0 ]]; then
        log "INFO" "Created files: ${created_files[*]}"
    fi

    # Report and handle missing files
    if [[ ${#missing_files[@]} -ne 0 ]]; then
        log "WARN" "Some files were not created: ${missing_files[*]}"

        # If JSON parsing provided missing files info, use that for better feedback
        if [[ "$json_parsed" == "true" && -n "$PARSED_MISSING_FILES" && "$PARSED_MISSING_FILES" != "[]" ]]; then
            log "INFO" "Missing files reported by Claude: $PARSED_MISSING_FILES"
        fi

        log "INFO" "You may need to create these files manually or run the conversion again"
    fi
}

# Main function
main() {
    local source_file="$1"
    local project_name="$2"
    
    # Validate arguments
    if [[ -z "$source_file" ]]; then
        log "ERROR" "Source file is required"
        show_help
        exit 1
    fi
    
    if [[ ! -f "$source_file" ]]; then
        log "ERROR" "Source file does not exist: $source_file"
        exit 1
    fi
    
    # Default project name from filename
    if [[ -z "$project_name" ]]; then
        project_name=$(basename "$source_file" | sed 's/\.[^.]*$//')
    fi
    
    log "INFO" "Converting PRD: $source_file"
    log "INFO" "Project name: $project_name"
    
    check_dependencies
    
    # Create project directory
    log "INFO" "Creating Ralph project: $project_name"
    ralph-setup "$project_name"
    cd "$project_name"

    # Copy source file to project (uses basename since we cd'd into project)
    local source_basename
    source_basename=$(basename "$source_file")
    if [[ "$source_file" == /* ]]; then
        cp "$source_file" "$source_basename"
    else
        cp "../$source_file" "$source_basename"
    fi

    # Run conversion using local copy (basename, not original path)
    convert_prd "$source_basename" "$project_name"
    
    log "SUCCESS" "🎉 PRD imported successfully!"
    echo ""
    echo "Next steps:"
    echo "  1. Review and edit the generated files:"
    echo "     - .ralph/PROMPT.md (Ralph instructions)"
    echo "     - .ralph/@fix_plan.md (task priorities)"
    echo "     - .ralph/specs/requirements.md (technical specs)"
    echo "  2. Start autonomous development:"
    echo "     ralph --monitor   # standalone Ralph"
    echo "     bmalph run       # bmalph-managed projects"
    echo ""
    echo "Project created in: $(pwd)"
}

# Handle command line arguments
case "${1:-}" in
    -h|--help|"")
        show_help
        exit 0
        ;;
    *)
        main "$@"
        ;;
esac
