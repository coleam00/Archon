#!/bin/bash

# pre-commit-check.sh
# Runs pre-commit validation checks
# Can be used as a git pre-commit hook or run manually

set -e

echo "Running pre-commit checks..."
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track overall status
ALL_PASSED=true

# Function to run a check and track status
run_check() {
  local check_name="$1"
  local check_command="$2"

  echo "=========================================="
  echo "Running: $check_name"
  echo "=========================================="

  if eval "$check_command"; then
    echo -e "${GREEN}✓ $check_name: PASS${NC}"
    echo ""
    return 0
  else
    echo -e "${RED}✗ $check_name: FAIL${NC}"
    echo ""
    ALL_PASSED=false
    return 1
  fi
}

# 1. Check for staged changes (if running as git hook)
if git rev-parse --git-dir > /dev/null 2>&1; then
  if ! git diff --cached --quiet; then
    echo "Found staged changes, proceeding with checks..."
    echo ""
  else
    echo -e "${YELLOW}Warning: No staged changes found${NC}"
    echo "Are you running this manually? Use: git add <files> first"
    echo ""
  fi
fi

# 2. Run linting
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/lint-check.sh" ]; then
  run_check "Linting" "$SCRIPT_DIR/lint-check.sh" || true
else
  echo -e "${YELLOW}Warning: lint-check.sh not found${NC}"
fi

# 3. Run tests
echo "=========================================="
echo "Running: Tests"
echo "=========================================="

if [ -f "package.json" ]; then
  # JavaScript/TypeScript
  if grep -q "\"test\":" package.json; then
    run_check "Tests" "npm test" || true
  else
    echo -e "${YELLOW}No test script found in package.json${NC}"
  fi

elif [ -f "pytest.ini" ] || [ -f "setup.py" ] || [ -f "pyproject.toml" ]; then
  # Python
  if command -v pytest &> /dev/null; then
    run_check "Tests" "pytest" || true
  else
    echo -e "${YELLOW}pytest not installed${NC}"
  fi

elif [ -f "go.mod" ]; then
  # Go
  run_check "Tests" "go test ./..." || true

elif [ -f "Cargo.toml" ]; then
  # Rust
  run_check "Tests" "cargo test" || true

elif [ -f "pom.xml" ]; then
  # Maven
  run_check "Tests" "mvn test" || true

elif [ -f "build.gradle" ] || [ -f "build.gradle.kts" ]; then
  # Gradle
  run_check "Tests" "./gradlew test" || true

else
  echo -e "${YELLOW}Could not detect test framework${NC}"
fi

echo ""

# 4. Check for common issues
echo "=========================================="
echo "Running: Common Issue Checks"
echo "=========================================="

# Check for debug statements
echo "Checking for debug statements..."
if git rev-parse --git-dir > /dev/null 2>&1; then
  DEBUG_FILES=$(git diff --cached --name-only | xargs grep -l "console.log\|debugger\|pdb.set_trace\|binding.pry" 2>/dev/null || true)
  if [ -n "$DEBUG_FILES" ]; then
    echo -e "${YELLOW}Warning: Debug statements found in:${NC}"
    echo "$DEBUG_FILES"
    echo "Consider removing before committing"
    echo ""
  else
    echo -e "${GREEN}✓ No debug statements found${NC}"
    echo ""
  fi
fi

# Check for TODO/FIXME in staged files
if git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Checking for TODO/FIXME comments..."
  TODO_COUNT=$(git diff --cached | grep -c "TODO\|FIXME" || true)
  if [ "$TODO_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}Warning: Found $TODO_COUNT TODO/FIXME comment(s) in staged changes${NC}"
    echo "Make sure they are documented and tracked"
    echo ""
  else
    echo -e "${GREEN}✓ No new TODO/FIXME comments${NC}"
    echo ""
  fi
fi

# Check for large files
if git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Checking for large files..."
  LARGE_FILES=$(git diff --cached --name-only | xargs ls -l 2>/dev/null | awk '$5 > 1048576 {print $9}' || true)
  if [ -n "$LARGE_FILES" ]; then
    echo -e "${RED}Error: Large files (>1MB) found:${NC}"
    echo "$LARGE_FILES"
    echo "Consider using Git LFS or reducing file size"
    echo ""
    ALL_PASSED=false
  else
    echo -e "${GREEN}✓ No large files detected${NC}"
    echo ""
  fi
fi

# Check for merge conflict markers
if git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Checking for merge conflict markers..."
  CONFLICT_FILES=$(git diff --cached --name-only | xargs grep -l "<<<<<<\|>>>>>>\|======" 2>/dev/null || true)
  if [ -n "$CONFLICT_FILES" ]; then
    echo -e "${RED}Error: Merge conflict markers found in:${NC}"
    echo "$CONFLICT_FILES"
    echo "Resolve conflicts before committing"
    echo ""
    ALL_PASSED=false
  else
    echo -e "${GREEN}✓ No merge conflict markers found${NC}"
    echo ""
  fi
fi

# Check for sensitive information
if git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Checking for potential secrets..."
  SECRET_PATTERNS="password|api_key|apikey|secret|token|private_key|aws_access|credential"
  SECRET_FILES=$(git diff --cached | grep -iE "$SECRET_PATTERNS" | grep -v "Binary files" || true)
  if [ -n "$SECRET_FILES" ]; then
    echo -e "${YELLOW}Warning: Potential secrets detected in staged changes${NC}"
    echo "Review carefully before committing:"
    echo "$SECRET_FILES"
    echo ""
  else
    echo -e "${GREEN}✓ No obvious secrets detected${NC}"
    echo ""
  fi
fi

# 5. Summary
echo "=========================================="
echo "Pre-commit Check Summary"
echo "=========================================="

if [ "$ALL_PASSED" = true ]; then
  echo -e "${GREEN}✓ All checks passed!${NC}"
  echo ""
  echo "Ready to commit."
  exit 0
else
  echo -e "${RED}✗ Some checks failed${NC}"
  echo ""
  echo "Please fix the issues above before committing."
  echo "To bypass these checks (not recommended), use: git commit --no-verify"
  exit 1
fi
