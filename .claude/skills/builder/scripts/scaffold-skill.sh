#!/bin/bash

# scaffold-skill.sh
# Creates a skill directory structure with standard subdirectories

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Usage information
usage() {
    cat <<EOF
Usage: $(basename "$0") <skill-name>

Creates a skill directory structure with standard subdirectories:
  - scripts/    (validation and utility scripts)
  - templates/  (reusable templates)
  - resources/  (reference documentation)

The skill name should be lowercase and hyphenated (e.g., 'qa-engineer').

Examples:
  $(basename "$0") qa-engineer
  $(basename "$0") security-analyst
  $(basename "$0") devops-engineer

The directory will be created in the current working directory.
EOF
    exit 1
}

# Check if skill name provided
if [ $# -eq 0 ]; then
    echo -e "${RED}Error: No skill name provided${NC}"
    usage
fi

SKILL_NAME="$1"

# Validate skill name format (lowercase, hyphenated)
if [[ ! "$SKILL_NAME" =~ ^[a-z][a-z0-9-]*$ ]]; then
    echo -e "${RED}Error: Skill name must be lowercase and hyphenated (e.g., 'my-skill')${NC}"
    exit 1
fi

# Check if directory already exists
if [ -d "$SKILL_NAME" ]; then
    echo -e "${RED}Error: Directory '$SKILL_NAME' already exists${NC}"
    exit 1
fi

echo -e "${BLUE}Creating skill directory structure for: $SKILL_NAME${NC}"
echo ""

# Create main directory
mkdir -p "$SKILL_NAME"
echo -e "${GREEN}✓ Created: $SKILL_NAME/${NC}"

# Create subdirectories
mkdir -p "$SKILL_NAME/scripts"
echo -e "${GREEN}✓ Created: $SKILL_NAME/scripts/${NC}"

mkdir -p "$SKILL_NAME/templates"
echo -e "${GREEN}✓ Created: $SKILL_NAME/templates/${NC}"

mkdir -p "$SKILL_NAME/resources"
echo -e "${GREEN}✓ Created: $SKILL_NAME/resources/${NC}"

# Create placeholder README in each subdirectory
cat > "$SKILL_NAME/scripts/README.md" <<EOF
# Scripts

Validation and utility scripts for the $SKILL_NAME skill.

## Available Scripts

- Add your scripts here
EOF

cat > "$SKILL_NAME/templates/README.md" <<EOF
# Templates

Reusable templates for the $SKILL_NAME skill.

## Available Templates

- Add your templates here
EOF

cat > "$SKILL_NAME/resources/README.md" <<EOF
# Resources

Reference documentation and patterns for the $SKILL_NAME skill.

## Available Resources

- Add your resources here
EOF

echo ""
echo "═══════════════════════════════════════"
echo -e "${GREEN}✓ Skill directory structure created successfully!${NC}"
echo ""
echo "Next steps:"
echo "1. Create SKILL.md in $SKILL_NAME/"
echo "2. Add YAML frontmatter with required fields (name, description)"
echo "3. Create REFERENCE.md for detailed patterns (optional)"
echo "4. Add scripts, templates, and resources as needed"
echo "5. Validate with: ./scripts/validate-skill.sh $SKILL_NAME/SKILL.md"
echo ""
echo "Directory structure:"
echo "$SKILL_NAME/"
echo "├── scripts/"
echo "│   └── README.md"
echo "├── templates/"
echo "│   └── README.md"
echo "└── resources/"
echo "    └── README.md"
