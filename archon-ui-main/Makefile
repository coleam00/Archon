# Makefile for Archon UI Frontend
# Uses Docker containers for consistent test execution

# Variables
DOCKER_IMAGE := archon-ui-test:latest
DOCKER_RUN := docker run --rm
DOCKER_RUN_IT := docker run --rm -it
PORT_MAPPING := -p 51204:51204
VOLUME_MOUNTS := -v "$$(pwd)/test-results:/app/public/test-results"
SOURCE_MOUNTS := -v "$$(pwd)/src:/app/src:ro" -v "$$(pwd)/test:/app/test:ro"

# Colors for output
RED := \033[0;31m
GREEN := \033[0;32m
YELLOW := \033[1;33m
NC := \033[0m # No Color

.PHONY: help
help: ## Show this help message
	@echo "Archon UI Frontend - Test Runner"
	@echo "================================"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "Examples:"
	@echo "  make test           # Run tests with coverage in Docker"
	@echo "  make test-local     # Run tests locally (requires npm install)"
	@echo "  make build-test     # Build the test Docker image"

# Docker-based testing targets
.PHONY: build-test
build-test: ## Build the test Docker container
	@echo "$(YELLOW)Building test container...$(NC)"
	@docker build -f Dockerfile.test -t $(DOCKER_IMAGE) .
	@echo "$(GREEN)✓ Test container built successfully$(NC)"

.PHONY: test
test: ensure-image ## Run tests with coverage in Docker
	@echo "$(YELLOW)Running tests with coverage...$(NC)"
	@$(DOCKER_RUN) $(VOLUME_MOUNTS) $(DOCKER_IMAGE) npm run test:coverage:stream
	@echo "$(GREEN)✓ All tests pass in Docker environment$(NC)"

.PHONY: test-watch
test-watch: ensure-image ## Run tests in watch mode (Docker)
	@echo "$(YELLOW)Running tests in watch mode...$(NC)"
	@$(DOCKER_RUN_IT) $(SOURCE_MOUNTS) $(DOCKER_IMAGE) npm run test

.PHONY: test-ui
test-ui: ensure-image ## Run tests with UI interface on port 51204 (Docker)
	@echo "$(YELLOW)Starting test UI on http://localhost:51204...$(NC)"
	@echo "$(YELLOW)Press Ctrl+C to stop$(NC)"
	@$(DOCKER_RUN_IT) $(PORT_MAPPING) $(SOURCE_MOUNTS) $(DOCKER_IMAGE) \
		npm run test:ui -- --host 0.0.0.0 --port 51204

.PHONY: test-ci
test-ci: build-test ## Run tests in CI mode (build and test)
	@echo "$(YELLOW)Running CI tests...$(NC)"
	@$(DOCKER_RUN) \
		-e CI=true \
		$(VOLUME_MOUNTS) \
		$(DOCKER_IMAGE) \
		npm run test:coverage:run
	@echo "$(GREEN)✓ CI tests completed$(NC)"

.PHONY: test-quick
test-quick: ensure-image ## Run tests quickly without coverage (Docker)
	@echo "$(YELLOW)Running quick tests...$(NC)"
	@$(DOCKER_RUN) $(DOCKER_IMAGE) npx vitest run --no-coverage
	@echo "$(GREEN)✓ Quick tests completed$(NC)"

.PHONY: lint-docker
lint-docker: ensure-image ## Run linting in Docker
	@echo "$(YELLOW)Running linting...$(NC)"
	@$(DOCKER_RUN) $(SOURCE_MOUNTS) $(DOCKER_IMAGE) npm run lint
	@echo "$(GREEN)✓ Linting completed$(NC)"

.PHONY: shell
shell: ensure-image ## Open shell in test container
	@echo "$(YELLOW)Opening shell in test container...$(NC)"
	@$(DOCKER_RUN_IT) $(SOURCE_MOUNTS) $(DOCKER_IMAGE) /bin/sh

# Local testing targets (requires npm install)
.PHONY: test-local
test-local: ## Run tests locally (requires npm install)
	@echo "$(YELLOW)Running tests locally...$(NC)"
	@npm run test:coverage:stream || (echo "$(RED)✗ Local tests failed. Did you run 'npm install'?$(NC)" && exit 1)
	@echo "$(GREEN)✓ Local tests completed$(NC)"

.PHONY: test-local-watch
test-local-watch: ## Run tests in watch mode locally
	@echo "$(YELLOW)Running tests in watch mode locally...$(NC)"
	@npm run test

.PHONY: test-local-ui
test-local-ui: ## Run test UI locally
	@echo "$(YELLOW)Starting test UI locally...$(NC)"
	@npm run test:ui

.PHONY: lint
lint: ## Run linting locally
	@echo "$(YELLOW)Running linting locally...$(NC)"
	@npm run lint || (echo "$(RED)✗ Linting failed$(NC)" && exit 1)
	@echo "$(GREEN)✓ Linting completed$(NC)"

# Development targets
.PHONY: install
install: ## Install dependencies locally
	@echo "$(YELLOW)Installing dependencies...$(NC)"
	@npm ci
	@echo "$(GREEN)✓ Dependencies installed$(NC)"

.PHONY: dev
dev: ## Start development server locally
	@echo "$(YELLOW)Starting development server...$(NC)"
	@npm run dev

.PHONY: build
build: ## Build production bundle locally
	@echo "$(YELLOW)Building production bundle...$(NC)"
	@npm run build
	@echo "$(GREEN)✓ Build completed$(NC)"

# Docker management targets
.PHONY: clean-docker
clean-docker: ## Remove test containers and images
	@echo "$(YELLOW)Cleaning up Docker resources...$(NC)"
	@docker rm -f $$(docker ps -a -q --filter ancestor=$(DOCKER_IMAGE)) 2>/dev/null || true
	@docker rmi $(DOCKER_IMAGE) 2>/dev/null || true
	@echo "$(GREEN)✓ Docker cleanup completed$(NC)"

.PHONY: clean
clean: ## Clean local build artifacts and test results
	@echo "$(YELLOW)Cleaning build artifacts...$(NC)"
	@rm -rf dist build coverage test-results public/test-results node_modules/.cache
	@echo "$(GREEN)✓ Cleanup completed$(NC)"

.PHONY: clean-all
clean-all: clean clean-docker ## Clean everything (local and Docker)
	@echo "$(GREEN)✓ Complete cleanup done$(NC)"

# Utility targets
.PHONY: ensure-image
ensure-image: ## Ensure Docker test image exists
	@if [ -z "$$(docker images -q $(DOCKER_IMAGE) 2>/dev/null)" ]; then \
		echo "$(YELLOW)Test image not found. Building...$(NC)"; \
		$(MAKE) build-test; \
	fi

.PHONY: test-results
test-results: ## Show test results summary
	@if [ -f test-results/test-results.json ]; then \
		echo "$(YELLOW)Test Results Summary:$(NC)"; \
		node -e "try { \
			const data = JSON.parse(require('fs').readFileSync('test-results/test-results.json', 'utf8')); \
			const passedTests = data.numPassedTests || 0; \
			const failedTests = data.numFailedTests || 0; \
			const totalTests = data.numTotalTests || 0; \
			const passedSuites = data.numPassedTestSuites || 0; \
			const failedSuites = data.numFailedTestSuites || 0; \
			const totalSuites = data.numTotalTestSuites || 0; \
			console.log(''); \
			console.log('Test Suites: ' + (failedSuites > 0 ? '\x1b[31m' + failedSuites + ' failed\x1b[0m, ' : '') + '\x1b[32m' + passedSuites + ' passed\x1b[0m, ' + totalSuites + ' total'); \
			console.log('Tests:       ' + (failedTests > 0 ? '\x1b[31m' + failedTests + ' failed\x1b[0m, ' : '') + '\x1b[32m' + passedTests + ' passed\x1b[0m, ' + totalTests + ' total'); \
		} catch(e) { \
			console.log('Error reading test results:', e.message); \
		}"; \
	else \
		echo "$(YELLOW)No test results found. Run 'make test' first.$(NC)"; \
	fi

.PHONY: coverage-report
coverage-report: ## Open coverage report in browser
	@if [ -d test-results/coverage ]; then \
		echo "$(YELLOW)Opening coverage report...$(NC)"; \
		open test-results/coverage/index.html 2>/dev/null || \
		xdg-open test-results/coverage/index.html 2>/dev/null || \
		echo "$(YELLOW)Coverage report available at: test-results/coverage/index.html$(NC)"; \
	else \
		echo "$(YELLOW)No coverage report found. Run 'make test' first.$(NC)"; \
	fi

# Composite targets
.PHONY: verify
verify: lint-docker test ## Run linting and tests (Docker)
	@echo "$(GREEN)✓ Verification completed$(NC)"

.PHONY: verify-local
verify-local: lint test-local ## Run linting and tests locally
	@echo "$(GREEN)✓ Local verification completed$(NC)"

.PHONY: ci
ci: clean test-ci test-results ## Full CI pipeline (clean, build, test)
	@echo "$(GREEN)✓ CI pipeline completed$(NC)"

# Docker Compose targets
.PHONY: dc-test
dc-test: ## Run tests using docker-compose
	@echo "$(YELLOW)Running tests with docker-compose...$(NC)"
	@docker-compose -f docker-compose.test.yml up --build test-runner
	@docker-compose -f docker-compose.test.yml down
	@echo "$(GREEN)✓ Docker-compose tests completed$(NC)"

.PHONY: dc-ui
dc-ui: ## Run test UI using docker-compose
	@echo "$(YELLOW)Starting test UI with docker-compose...$(NC)"
	@docker-compose -f docker-compose.test.yml --profile ui up --build test-ui

.PHONY: dc-down
dc-down: ## Stop docker-compose services
	@docker-compose -f docker-compose.test.yml down

# Default target
.DEFAULT_GOAL := help

# Quick aliases
.PHONY: t
t: test ## Alias for 'test'

.PHONY: tw
tw: test-watch ## Alias for 'test-watch'

.PHONY: tl
tl: test-local ## Alias for 'test-local'

.PHONY: b
b: build ## Alias for 'build'

.PHONY: d
d: dev ## Alias for 'dev'