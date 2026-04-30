#!/bin/bash

# lint-check.sh
# Runs linting checks for the project
# Automatically detects project type and runs appropriate linter

set -e

echo "Running lint checks..."
echo ""

# Detect project type and run appropriate linter
if [ -f "package.json" ]; then
  # JavaScript/TypeScript project

  if grep -q "\"eslint\":" package.json || [ -f ".eslintrc.js" ] || [ -f ".eslintrc.json" ] || [ -f "eslint.config.js" ]; then
    echo "Detected ESLint configuration"

    if [ -f "node_modules/.bin/eslint" ]; then
      npx eslint . --ext .js,.jsx,.ts,.tsx
      echo "ESLint: PASS"
    else
      echo "Error: ESLint not installed. Run 'npm install'"
      exit 1
    fi
  else
    echo "No ESLint configuration found"
    echo "Consider adding ESLint: npm install --save-dev eslint"
  fi

  # Check for Prettier
  if grep -q "\"prettier\":" package.json || [ -f ".prettierrc" ] || [ -f ".prettierrc.json" ]; then
    echo ""
    echo "Checking Prettier formatting..."

    if [ -f "node_modules/.bin/prettier" ]; then
      npx prettier --check .
      echo "Prettier: PASS"
    else
      echo "Warning: Prettier not installed"
    fi
  fi

  # Check for TypeScript
  if [ -f "tsconfig.json" ]; then
    echo ""
    echo "Running TypeScript compiler check..."

    if [ -f "node_modules/.bin/tsc" ]; then
      npx tsc --noEmit
      echo "TypeScript: PASS"
    else
      echo "Warning: TypeScript not installed"
    fi
  fi

elif [ -f "pyproject.toml" ] || [ -f "setup.py" ] || [ -f ".flake8" ] || [ -f "pylintrc" ]; then
  # Python project
  echo "Detected Python project"

  # Check for ruff (modern fast linter)
  if command -v ruff &> /dev/null; then
    echo "Running ruff..."
    ruff check .
    echo "Ruff: PASS"

  # Check for flake8
  elif command -v flake8 &> /dev/null; then
    echo "Running flake8..."
    flake8 .
    echo "Flake8: PASS"

  # Check for pylint
  elif command -v pylint &> /dev/null; then
    echo "Running pylint..."
    find . -name "*.py" -not -path "./venv/*" -not -path "./.venv/*" | xargs pylint
    echo "Pylint: PASS"

  else
    echo "No Python linter found (ruff, flake8, or pylint)"
    echo "Install one: pip install ruff (recommended)"
    exit 1
  fi

  # Check for black (formatter)
  if command -v black &> /dev/null; then
    echo ""
    echo "Checking Black formatting..."
    black --check .
    echo "Black: PASS"
  fi

  # Check for mypy (type checker)
  if command -v mypy &> /dev/null; then
    echo ""
    echo "Running mypy type checking..."
    mypy .
    echo "Mypy: PASS"
  fi

elif [ -f "go.mod" ]; then
  # Go project
  echo "Detected Go project"

  echo "Running go vet..."
  go vet ./...
  echo "go vet: PASS"

  echo ""
  echo "Running go fmt check..."
  UNFORMATTED=$(gofmt -l .)
  if [ -n "$UNFORMATTED" ]; then
    echo "The following files are not formatted:"
    echo "$UNFORMATTED"
    echo "Run: gofmt -w ."
    exit 1
  fi
  echo "go fmt: PASS"

  # Check for golangci-lint
  if command -v golangci-lint &> /dev/null; then
    echo ""
    echo "Running golangci-lint..."
    golangci-lint run
    echo "golangci-lint: PASS"
  fi

  # Check for staticcheck
  if command -v staticcheck &> /dev/null; then
    echo ""
    echo "Running staticcheck..."
    staticcheck ./...
    echo "staticcheck: PASS"
  fi

elif [ -f "Cargo.toml" ]; then
  # Rust project
  echo "Detected Rust project"

  echo "Running cargo clippy..."
  cargo clippy -- -D warnings
  echo "Clippy: PASS"

  echo ""
  echo "Running cargo fmt check..."
  cargo fmt -- --check
  echo "Cargo fmt: PASS"

elif [ -f "pom.xml" ]; then
  # Java/Maven project
  echo "Detected Maven project"

  echo "Running Maven checkstyle..."
  if mvn checkstyle:check 2>/dev/null; then
    echo "Checkstyle: PASS"
  else
    echo "Checkstyle plugin not configured"
    echo "Add maven-checkstyle-plugin to pom.xml"
  fi

elif [ -f "build.gradle" ] || [ -f "build.gradle.kts" ]; then
  # Java/Gradle project
  echo "Detected Gradle project"

  if ./gradlew tasks 2>/dev/null | grep -q "checkstyleMain"; then
    echo "Running Gradle checkstyle..."
    ./gradlew checkstyleMain checkstyleTest
    echo "Checkstyle: PASS"
  else
    echo "Checkstyle plugin not configured"
    echo "Add checkstyle plugin to build.gradle"
  fi

elif [ -f ".rubocop.yml" ] || command -v rubocop &> /dev/null; then
  # Ruby project
  echo "Detected Ruby project"

  if command -v rubocop &> /dev/null; then
    echo "Running RuboCop..."
    rubocop
    echo "RuboCop: PASS"
  else
    echo "RuboCop not installed: gem install rubocop"
    exit 1
  fi

else
  echo "Could not detect project type or linter configuration."
  echo ""
  echo "Supported linters:"
  echo "  JavaScript/TypeScript: ESLint, Prettier"
  echo "  Python: ruff, flake8, pylint, black, mypy"
  echo "  Go: go vet, go fmt, golangci-lint, staticcheck"
  echo "  Rust: clippy, cargo fmt"
  echo "  Java: checkstyle (Maven/Gradle)"
  echo "  Ruby: RuboCop"
  echo ""
  echo "Please configure a linter for your project or run manually."
  exit 1
fi

echo ""
echo "All lint checks passed!"
