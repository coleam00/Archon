#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🤖 Local Release Notes Generator Test${NC}"
echo "=========================================="
echo

# Check for required tools
command -v jq >/dev/null 2>&1 || { echo -e "${RED}❌ jq is required but not installed. Install with: apt install jq${NC}" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo -e "${RED}❌ curl is required but not installed.${NC}" >&2; exit 1; }

# Check for API key
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo -e "${RED}❌ ANTHROPIC_API_KEY environment variable not set${NC}"
    echo -e "${YELLOW}Export your key first: export ANTHROPIC_API_KEY=sk-ant-...${NC}"
    exit 1
fi

# Parse arguments for branch/tag comparison
if [ -n "$2" ]; then
    # Two arguments: compare from $1 to $2
    PREVIOUS_TAG="$1"
    CURRENT_TAG="$2"
    echo -e "${GREEN}Comparing: $PREVIOUS_TAG → $CURRENT_TAG${NC}"
    IS_FIRST_RELEASE="false"
elif [ -n "$1" ]; then
    # One argument - could be a tag or a range
    if [[ "$1" == *".."* ]]; then
        # Range format: stable..main
        PREVIOUS_TAG="${1%%..*}"
        CURRENT_TAG="${1##*..}"
        echo -e "${GREEN}Comparing range: $PREVIOUS_TAG → $CURRENT_TAG${NC}"
    else
        # Single tag/branch - compare with previous tag or initial commit
        CURRENT_TAG="$1"
        PREVIOUS_TAG=$(git tag --sort=-v:refname | grep -A1 "^${CURRENT_TAG}$" | tail -1)

        if [ -z "$PREVIOUS_TAG" ] || [ "$PREVIOUS_TAG" == "$CURRENT_TAG" ]; then
            PREVIOUS_TAG=$(git rev-list --max-parents=0 HEAD)
            IS_FIRST_RELEASE="true"
            echo -e "${YELLOW}First release - comparing against initial commit${NC}"
        else
            IS_FIRST_RELEASE="false"
            echo -e "${GREEN}Current: $CURRENT_TAG, Previous: $PREVIOUS_TAG${NC}"
        fi
    fi
    IS_FIRST_RELEASE="false"
else
    # No arguments - default to origin/stable..main comparison
    PREVIOUS_TAG="origin/stable"
    CURRENT_TAG="main"
    echo -e "${BLUE}No arguments provided - comparing branches: origin/stable → main${NC}"
    echo -e "${YELLOW}Usage:${NC}"
    echo -e "${YELLOW}  $0                           # Compare origin/stable..main (default)${NC}"
    echo -e "${YELLOW}  $0 origin/stable main        # Compare two branches${NC}"
    echo -e "${YELLOW}  $0 origin/stable..main       # Range syntax${NC}"
    echo -e "${YELLOW}  $0 v1.0.0                    # Compare with previous tag${NC}"
    echo -e "${YELLOW}  $0 v1.0.0 v2.0.0             # Compare two tags${NC}"
    echo
    IS_FIRST_RELEASE="false"
fi

# Normalize branch/tag references (handle remote branches)
# If a branch name doesn't exist locally, try origin/<branch>
normalize_ref() {
    local ref="$1"

    # If it already has origin/ prefix or is a commit hash, use as-is
    if [[ "$ref" == origin/* ]] || git rev-parse -q --verify "$ref" >/dev/null 2>&1; then
        echo "$ref"
        return
    fi

    # Try local branch first
    if git rev-parse -q --verify "$ref" >/dev/null 2>&1; then
        echo "$ref"
        return
    fi

    # Try as remote branch
    if git rev-parse -q --verify "origin/$ref" >/dev/null 2>&1; then
        echo "origin/$ref"
        return
    fi

    # Return original if nothing works (will fail later with clear error)
    echo "$ref"
}

PREVIOUS_TAG=$(normalize_ref "$PREVIOUS_TAG")
CURRENT_TAG=$(normalize_ref "$CURRENT_TAG")

echo -e "${GREEN}Comparing: ${PREVIOUS_TAG} → ${CURRENT_TAG}${NC}"
echo

# Get commit messages
echo -e "${BLUE}📝 Gathering commits...${NC}"
COMMITS=$(git log ${PREVIOUS_TAG}..${CURRENT_TAG} --pretty=format:"- %s (%h) by %an" --no-merges)
COMMIT_COUNT=$(echo "$COMMITS" | wc -l)
echo -e "${GREEN}Found $COMMIT_COUNT commits${NC}"

# Get file changes
echo -e "${BLUE}📊 Analyzing file changes...${NC}"
FILES_CHANGED=$(git diff ${PREVIOUS_TAG}..${CURRENT_TAG} --stat | tail -1)

# Detailed changes by component
CHANGES_FRONTEND=$(git diff ${PREVIOUS_TAG}..${CURRENT_TAG} --stat -- archon-ui-main/ | head -20)
CHANGES_BACKEND=$(git diff ${PREVIOUS_TAG}..${CURRENT_TAG} --stat -- python/ | head -20)
CHANGES_DOCS=$(git diff ${PREVIOUS_TAG}..${CURRENT_TAG} --stat -- '*.md' PRPs/ | head -10)

FILE_CHANGES="### File Changes by Component

**Frontend:**
$CHANGES_FRONTEND

**Backend:**
$CHANGES_BACKEND

**Documentation:**
$CHANGES_DOCS"

echo -e "${GREEN}Files summary: $FILES_CHANGED${NC}"

# Get merged PRs (using gh CLI if available)
echo -e "${BLUE}🔀 Looking for merged PRs...${NC}"
if command -v gh >/dev/null 2>&1; then
    PREV_DATE=$(git log -1 --format=%ai ${PREVIOUS_TAG})
    PRS=$(gh pr list \
        --state merged \
        --limit 100 \
        --json number,title,mergedAt,author,url \
        --jq --arg date "$PREV_DATE" \
          '.[] | select(.mergedAt >= $date) | "- #\(.number): \(.title) by @\(.author.login) - \(.url)"' \
        2>/dev/null || echo "No PRs found or unable to fetch")
    PR_COUNT=$(echo "$PRS" | grep -c '^-' || echo "0")
    echo -e "${GREEN}Found $PR_COUNT merged PRs${NC}"
else
    PRS="No PRs fetched (gh CLI not available)"
    echo -e "${YELLOW}gh CLI not available - skipping PR detection${NC}"
fi

echo

# Get repository info
REPO_FULL=$(git config --get remote.origin.url | sed 's/.*github.com[:/]\(.*\)\.git/\1/')
REPO_OWNER=$(echo "$REPO_FULL" | cut -d'/' -f1)
REPO_NAME=$(echo "$REPO_FULL" | cut -d'/' -f2)

# Create prompt for Claude
echo -e "${BLUE}🤖 Generating release notes with Claude...${NC}"

# Build the prompt content
PROMPT_CONTENT="You are writing release notes for Archon V2 Beta, a local-first AI knowledge management system.

## Release Information

**Version:** ${CURRENT_TAG}
**Previous Version:** ${PREVIOUS_TAG}
**Commits:** ${COMMIT_COUNT}
**Is First Release:** ${IS_FIRST_RELEASE}

## Commits

\`\`\`
${COMMITS}
\`\`\`

## Pull Requests Merged

\`\`\`
${PRS}
\`\`\`

## File Changes

\`\`\`
${FILE_CHANGES}
\`\`\`

## Instructions

Generate comprehensive release notes following this structure:

# 🚀 Release ${CURRENT_TAG}

## 📝 Overview
[2-3 sentence summary of this release]

## ✨ What's New

### Major Features
- [List major new features with brief descriptions]

### Improvements
- [List improvements and enhancements]

### Bug Fixes
- [List bug fixes]

## 🔧 Technical Changes

### Backend (Python/FastAPI)
- [Notable backend changes]

### Frontend (React/TypeScript)
- [Notable frontend changes]

### Infrastructure
- [Docker, CI/CD, deployment changes]

## 📊 Statistics
- **Commits:** ${COMMIT_COUNT}
- **Pull Requests:** [Count from PRs list]
- **Files Changed:** [From file stats]
- **Contributors:** [Unique authors from commits]

## 🙏 Contributors

Thanks to everyone who contributed to this release:
[List unique contributors with @ mentions]

## 📚 Documentation

[If documentation changes, list them]

## ⚠️ Breaking Changes

[List any breaking changes - this is beta software, so breaking changes are expected]

## 🔗 Links

- **Full Changelog:** https://github.com/${REPO_FULL}/compare/${PREVIOUS_TAG}...${CURRENT_TAG}
- **Installation Guide:** [Link to docs]

---

**Note:** This is a beta release. Features may change rapidly. Report issues at: https://github.com/${REPO_FULL}/issues

---

Write in a professional yet enthusiastic tone. Focus on user-facing changes. Be specific but concise."

# Create the request using jq to properly escape JSON
jq -n \
  --arg model "claude-sonnet-4-20250514" \
  --arg content "$PROMPT_CONTENT" \
  '{
    model: $model,
    max_tokens: 4096,
    temperature: 0.7,
    messages: [
      {
        role: "user",
        content: $content
      }
    ]
  }' > /tmp/claude_request.json

# Call Claude API
RESPONSE=$(curl -s https://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d @/tmp/claude_request.json)

# Check for errors
if echo "$RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
    echo -e "${RED}❌ API Error:${NC}"
    echo "$RESPONSE" | jq '.error'
    exit 1
fi

# Extract release notes
RELEASE_NOTES=$(echo "$RESPONSE" | jq -r '.content[0].text')

if [ -z "$RELEASE_NOTES" ] || [ "$RELEASE_NOTES" == "null" ]; then
    echo -e "${RED}❌ Failed to extract release notes from response${NC}"
    echo "Response:"
    echo "$RESPONSE" | jq .
    exit 1
fi

# Save to file
# Create safe filename from branch/tag names
SAFE_FROM=$(echo "$PREVIOUS_TAG" | tr '/' '-')
SAFE_TO=$(echo "$CURRENT_TAG" | tr '/' '-')
OUTPUT_FILE="release-notes-${SAFE_FROM}..${SAFE_TO}.md"
echo "$RELEASE_NOTES" > "$OUTPUT_FILE"

echo -e "${GREEN}✅ Release notes generated successfully!${NC}"
echo
echo -e "${BLUE}📄 Output saved to: ${OUTPUT_FILE}${NC}"
echo
echo "=========================================="
echo -e "${YELLOW}Preview:${NC}"
echo "=========================================="
cat "$OUTPUT_FILE"
echo
echo "=========================================="
echo -e "${GREEN}✅ Done!${NC}"
echo
echo "To create a GitHub release with these notes:"
echo -e "${YELLOW}gh release create ${CURRENT_TAG} --title 'Release ${CURRENT_TAG}' --notes-file ${OUTPUT_FILE}${NC}"
