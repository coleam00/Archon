#!/bin/bash

# run-tests.sh - Helper script for running Archon UI tests in Docker

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_color() {
    color=$1
    message=$2
    echo -e "${color}${message}${NC}"
}

# Function to show usage
show_usage() {
    echo "Usage: $0 [OPTION]"
    echo "Run Archon UI tests in Docker container"
    echo ""
    echo "Options:"
    echo "  build       Build the test container"
    echo "  test        Run tests with coverage (default)"
    echo "  watch       Run tests in watch mode"
    echo "  ui          Run tests with UI interface"
    echo "  lint        Run linting"
    echo "  shell       Open shell in test container"
    echo "  clean       Remove test containers and images"
    echo "  help        Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0              # Run tests with coverage"
    echo "  $0 build        # Build test container"
    echo "  $0 ui           # Run test UI on http://localhost:51204"
}

# Function to build the test container
build_container() {
    print_color "$YELLOW" "Building test container..."
    docker build -f Dockerfile.test -t archon-ui-test:latest .
    print_color "$GREEN" "✓ Container built successfully"
}

# Function to run tests with coverage
run_tests() {
    print_color "$YELLOW" "Running tests with coverage..."
    docker run --rm \
        -v "$(pwd)/test-results:/app/public/test-results" \
        archon-ui-test:latest \
        npm run test:coverage:stream
    print_color "$GREEN" "✓ Tests completed"
}

# Function to run tests in watch mode
run_watch() {
    print_color "$YELLOW" "Running tests in watch mode..."
    docker run --rm -it \
        -v "$(pwd)/src:/app/src:ro" \
        -v "$(pwd)/test:/app/test:ro" \
        archon-ui-test:latest \
        npm run test
}

# Function to run test UI
run_ui() {
    print_color "$YELLOW" "Starting test UI on http://localhost:51204..."
    docker run --rm -it \
        -p 51204:51204 \
        -v "$(pwd)/src:/app/src:ro" \
        -v "$(pwd)/test:/app/test:ro" \
        archon-ui-test:latest \
        npm run test:ui -- --host 0.0.0.0 --port 51204
}

# Function to run linting
run_lint() {
    print_color "$YELLOW" "Running linting..."
    docker run --rm \
        -v "$(pwd)/src:/app/src:ro" \
        archon-ui-test:latest \
        npm run lint
    print_color "$GREEN" "✓ Linting completed"
}

# Function to open shell in container
run_shell() {
    print_color "$YELLOW" "Opening shell in test container..."
    docker run --rm -it \
        -v "$(pwd)/src:/app/src:ro" \
        -v "$(pwd)/test:/app/test:ro" \
        archon-ui-test:latest \
        /bin/sh
}

# Function to clean up containers and images
clean_up() {
    print_color "$YELLOW" "Cleaning up test containers and images..."
    # Remove any running containers using the test image
    docker ps -a --filter "ancestor=archon-ui-test:latest" --format '{{.ID}}' | xargs -r docker rm -f 2>/dev/null || true
    # Remove the test image
    docker rmi archon-ui-test:latest 2>/dev/null || true
    print_color "$GREEN" "✓ Cleanup completed"
}

# Main script logic
case "${1:-test}" in
    build)
        build_container
        ;;
    test)
        if [[ "$(docker images -q archon-ui-test:latest 2> /dev/null)" == "" ]]; then
            build_container
        fi
        run_tests
        ;;
    watch)
        if [[ "$(docker images -q archon-ui-test:latest 2> /dev/null)" == "" ]]; then
            build_container
        fi
        run_watch
        ;;
    ui)
        if [[ "$(docker images -q archon-ui-test:latest 2> /dev/null)" == "" ]]; then
            build_container
        fi
        run_ui
        ;;
    lint)
        if [[ "$(docker images -q archon-ui-test:latest 2> /dev/null)" == "" ]]; then
            build_container
        fi
        run_lint
        ;;
    shell)
        if [[ "$(docker images -q archon-ui-test:latest 2> /dev/null)" == "" ]]; then
            build_container
        fi
        run_shell
        ;;
    clean)
        clean_up
        ;;
    help|--help|-h)
        show_usage
        ;;
    *)
        print_color "$RED" "Unknown option: $1"
        show_usage
        exit 1
        ;;
esac