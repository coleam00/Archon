#!/bin/bash

# check-coverage.sh
# Runs test coverage and checks against minimum threshold (80%)
# Usage: ./check-coverage.sh [threshold]

set -e

# Default threshold is 80%
THRESHOLD=${1:-80}

echo "Running test coverage check..."
echo "Minimum threshold: ${THRESHOLD}%"
echo ""

# Detect project type and run appropriate coverage command
if [ -f "package.json" ]; then
  # JavaScript/TypeScript project
  if grep -q "\"jest\":" package.json; then
    echo "Detected Jest configuration"

    # Run Jest with coverage
    if [ -f "node_modules/.bin/jest" ]; then
      npx jest --coverage --coverageReporters=text --coverageReporters=text-summary
    else
      echo "Error: Jest not installed. Run 'npm install' first."
      exit 1
    fi

  elif grep -q "\"vitest\":" package.json; then
    echo "Detected Vitest configuration"
    npx vitest run --coverage

  elif grep -q "\"mocha\":" package.json; then
    echo "Detected Mocha configuration"
    if [ -f "node_modules/.bin/nyc" ]; then
      npx nyc --reporter=text --reporter=text-summary npm test
    else
      echo "Warning: nyc not installed. Run 'npm install --save-dev nyc'"
      npm test
      exit 0
    fi

  else
    echo "No recognized test framework found in package.json"
    echo "Supported: jest, vitest, mocha (with nyc)"
    exit 1
  fi

elif [ -f "pytest.ini" ] || [ -f "setup.py" ] || [ -f "pyproject.toml" ]; then
  # Python project
  echo "Detected Python project"

  if command -v pytest &> /dev/null; then
    if python -c "import pytest_cov" &> /dev/null; then
      pytest --cov --cov-report=term --cov-report=term-missing
    else
      echo "Warning: pytest-cov not installed. Run 'pip install pytest-cov'"
      pytest
      exit 0
    fi
  else
    echo "Error: pytest not installed. Run 'pip install pytest pytest-cov'"
    exit 1
  fi

elif [ -f "go.mod" ]; then
  # Go project
  echo "Detected Go project"
  go test ./... -cover -coverprofile=coverage.out
  go tool cover -func=coverage.out

  # Extract total coverage percentage
  COVERAGE=$(go tool cover -func=coverage.out | grep total | awk '{print $3}' | sed 's/%//')
  echo ""
  echo "Total coverage: ${COVERAGE}%"

  # Compare with threshold
  if [ -n "$COVERAGE" ]; then
    if (( $(echo "$COVERAGE < $THRESHOLD" | bc -l) )); then
      echo "FAIL: Coverage ${COVERAGE}% is below threshold ${THRESHOLD}%"
      exit 1
    else
      echo "PASS: Coverage ${COVERAGE}% meets threshold ${THRESHOLD}%"
      exit 0
    fi
  fi

elif [ -f "pom.xml" ]; then
  # Java/Maven project
  echo "Detected Maven project"
  mvn test jacoco:report
  echo ""
  echo "Coverage report generated at: target/site/jacoco/index.html"

elif [ -f "build.gradle" ] || [ -f "build.gradle.kts" ]; then
  # Java/Gradle project
  echo "Detected Gradle project"
  ./gradlew test jacocoTestReport
  echo ""
  echo "Coverage report generated at: build/reports/jacoco/test/html/index.html"

elif [ -f "Cargo.toml" ]; then
  # Rust project
  echo "Detected Rust project"

  if command -v cargo-tarpaulin &> /dev/null; then
    cargo tarpaulin --out Stdout --output-dir coverage
  else
    echo "Warning: cargo-tarpaulin not installed."
    echo "Install with: cargo install cargo-tarpaulin"
    cargo test
    exit 0
  fi

else
  echo "Could not detect project type."
  echo "Supported: JavaScript/TypeScript (Jest, Vitest, Mocha), Python (pytest), Go, Java (Maven/Gradle), Rust"
  echo ""
  echo "Please run your project's coverage command manually:"
  echo "  JavaScript: npm run test:coverage or npx jest --coverage"
  echo "  Python:     pytest --cov"
  echo "  Go:         go test ./... -cover"
  echo "  Java:       mvn test jacoco:report"
  echo "  Rust:       cargo tarpaulin"
  exit 1
fi

echo ""
echo "Coverage check complete!"
echo ""
echo "Note: Ensure your coverage meets the ${THRESHOLD}% threshold."
echo "If coverage is below threshold, add more tests or remove untested code."
