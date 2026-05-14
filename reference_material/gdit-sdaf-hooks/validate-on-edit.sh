#!/usr/bin/env bash
# Hook: PostToolUse(Edit|Write) — remind to validate spec files after edit
# Exit: always 0 (advisory only)

# Read the tool input from stdin to get the file path
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null)

if [[ "$FILE_PATH" == *".kiro/specs/"* ]]; then
    SPEC_DIR=$(echo "$FILE_PATH" | sed 's|\(.kiro/specs/[^/]*/\).*|\1|')
    echo "Spec file modified: $FILE_PATH" >&2
    echo "Run: python3 ~/.kiro/scripts/validate-spec.py $SPEC_DIR" >&2
fi

exit 0
