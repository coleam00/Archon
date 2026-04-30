#!/bin/bash

# validate-skill.sh
# Validates that a SKILL.md file has required YAML frontmatter fields

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Usage information
usage() {
    cat <<EOF
Usage: $(basename "$0") <path-to-SKILL.md>

Validates that a SKILL.md file has required YAML frontmatter:
  - name (required)
  - description (required)
  - allowed-tools (optional but recommended)

Examples:
  $(basename "$0") ./SKILL.md
  $(basename "$0") /home/user/.claude/skills/bmad/builder/SKILL.md
EOF
    exit 1
}

# Check if file path provided
if [ $# -eq 0 ]; then
    echo -e "${RED}Error: No file path provided${NC}"
    usage
fi

SKILL_FILE="$1"

# Check if file exists
if [ ! -f "$SKILL_FILE" ]; then
    echo -e "${RED}Error: File not found: $SKILL_FILE${NC}"
    exit 1
fi

# Check if file is named SKILL.md
if [[ ! "$(basename "$SKILL_FILE")" == "SKILL.md" ]]; then
    echo -e "${YELLOW}Warning: File is not named SKILL.md${NC}"
fi

echo "Validating: $SKILL_FILE"
echo ""

# Extract YAML frontmatter (between --- lines)
yaml_content=$(awk '/^---$/{if(++count==1)next; if(count==2)exit} count==1' "$SKILL_FILE")

if [ -z "$yaml_content" ]; then
    echo -e "${RED}✗ FAIL: No YAML frontmatter found${NC}"
    echo "  SKILL.md must start with YAML frontmatter between --- markers"
    exit 1
fi

echo -e "${GREEN}✓ YAML frontmatter found${NC}"

# Validation results
errors=0
warnings=0

# Check for required 'name' field
if echo "$yaml_content" | grep -q "^name:"; then
    name_value=$(echo "$yaml_content" | grep "^name:" | sed 's/^name: *//' | tr -d '"' | tr -d "'")
    echo -e "${GREEN}✓ 'name' field present: $name_value${NC}"

    # Validate name format (lowercase, hyphenated)
    if [[ ! "$name_value" =~ ^[a-z][a-z0-9-]*$ ]]; then
        echo -e "${YELLOW}  ⚠ Warning: 'name' should be lowercase and hyphenated (e.g., 'my-skill-name')${NC}"
        ((warnings++))
    fi
else
    echo -e "${RED}✗ 'name' field missing (REQUIRED)${NC}"
    ((errors++))
fi

# Check for required 'description' field
if echo "$yaml_content" | grep -q "^description:"; then
    desc_value=$(echo "$yaml_content" | grep "^description:" | sed 's/^description: *//')
    echo -e "${GREEN}✓ 'description' field present${NC}"

    # Check if description has trigger keywords
    if [[ ${#desc_value} -lt 20 ]]; then
        echo -e "${YELLOW}  ⚠ Warning: 'description' seems short. Include trigger keywords for better activation.${NC}"
        ((warnings++))
    fi
else
    echo -e "${RED}✗ 'description' field missing (REQUIRED)${NC}"
    ((errors++))
fi

# Check for optional but recommended 'allowed-tools' field
if echo "$yaml_content" | grep -q "^allowed-tools:"; then
    tools_value=$(echo "$yaml_content" | grep "^allowed-tools:" | sed 's/^allowed-tools: *//')
    echo -e "${GREEN}✓ 'allowed-tools' field present: $tools_value${NC}"
else
    echo -e "${YELLOW}⚠ 'allowed-tools' field not found (recommended but optional)${NC}"
    ((warnings++))
fi

# Check file size (should be under 5k tokens, roughly 20KB)
file_size=$(wc -c < "$SKILL_FILE")
if [ "$file_size" -gt 20000 ]; then
    echo -e "${YELLOW}⚠ Warning: File size is ${file_size} bytes (consider using references to keep under 5k tokens)${NC}"
    ((warnings++))
fi

# Summary
echo ""
echo "═══════════════════════════════════════"
if [ $errors -eq 0 ]; then
    if [ $warnings -eq 0 ]; then
        echo -e "${GREEN}✓ VALIDATION PASSED${NC}"
        echo "  No errors or warnings"
    else
        echo -e "${GREEN}✓ VALIDATION PASSED${NC}"
        echo -e "${YELLOW}  $warnings warning(s) found${NC}"
    fi
    exit 0
else
    echo -e "${RED}✗ VALIDATION FAILED${NC}"
    echo "  $errors error(s), $warnings warning(s)"
    exit 1
fi
