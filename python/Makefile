# Archon Server Makefile
# Repository Pattern Implementation and Testing

.PHONY: help
help: ## Show this help message
	@echo "Usage: make [target]"
	@echo ""
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install all dependencies using uv
	uv sync
	@echo "✅ Dependencies installed"

.PHONY: test
test: ## Run all tests
	uv run pytest tests/ -v --tb=short
	@echo "✅ All tests completed"

.PHONY: test-repo
test-repo: ## Run repository pattern tests only
	uv run pytest tests/test_repository*.py -v --tb=short
	@echo "✅ Repository tests completed"

.PHONY: test-coverage
test-coverage: ## Run tests with coverage report
	uv run pytest tests/ --cov=src.server --cov-report=term-missing --cov-report=html
	@echo "✅ Coverage report generated in htmlcov/"

.PHONY: test-repo-coverage
test-repo-coverage: ## Run repository tests with coverage
	uv run pytest tests/test_repository*.py --cov=src.server.repositories --cov-report=term-missing
	@echo "✅ Repository coverage report generated"

.PHONY: test-fast
test-fast: ## Run tests in parallel (faster)
	uv run pytest tests/ -v --tb=short -n auto
	@echo "✅ Fast test run completed"

.PHONY: test-unit
test-unit: ## Run unit tests only (exclude integration tests)
	uv run pytest tests/ -v --tb=short -m "not integration"
	@echo "✅ Unit tests completed"

.PHONY: test-integration
test-integration: ## Run integration tests only
	uv run pytest tests/ -v --tb=short -m "integration"
	@echo "✅ Integration tests completed"

.PHONY: lint
lint: ## Run code linting with ruff
	uv run ruff check src/ tests/ --fix
	@echo "✅ Linting completed"

.PHONY: format
format: ## Format code with ruff
	uv run ruff format src/ tests/
	@echo "✅ Code formatting completed"

.PHONY: typecheck
typecheck: ## Run type checking with mypy
	uv run mypy src/ --ignore-missing-imports
	@echo "✅ Type checking completed"

.PHONY: check
check: lint typecheck test ## Run all checks (lint, typecheck, test)
	@echo "✅ All checks passed"

.PHONY: clean
clean: ## Clean up temporary files and caches
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name ".ruff_cache" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name "htmlcov" -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete
	find . -type f -name ".coverage" -delete
	@echo "✅ Cleanup completed"

.PHONY: run
run: ## Run the main server
	uv run python -m src.server.main
	@echo "✅ Server stopped"

.PHONY: run-dev
run-dev: ## Run server in development mode with auto-reload
	uv run uvicorn src.server.main:app --reload --host 0.0.0.0 --port 8181
	@echo "✅ Development server stopped"

.PHONY: run-mcp
run-mcp: ## Run the MCP server
	uv run python -m src.mcp.mcp_server
	@echo "✅ MCP server stopped"

.PHONY: run-agents
run-agents: ## Run the agents service
	uv run python -m src.agents.main
	@echo "✅ Agents service stopped"

.PHONY: docker-build
docker-build: ## Build Docker images
	docker-compose build
	@echo "✅ Docker images built"

.PHONY: docker-up
docker-up: ## Start Docker services
	docker-compose up -d
	@echo "✅ Docker services started"

.PHONY: docker-down
docker-down: ## Stop Docker services
	docker-compose down
	@echo "✅ Docker services stopped"

.PHONY: docker-logs
docker-logs: ## Show Docker logs
	docker-compose logs -f

.PHONY: docker-restart
docker-restart: docker-down docker-up ## Restart Docker services
	@echo "✅ Docker services restarted"

.PHONY: db-migrate
db-migrate: ## Run database migrations
	@echo "Running database migrations..."
	# Add migration command here when available
	@echo "✅ Migrations completed"

.PHONY: shell
shell: ## Open Python shell with project context
	uv run python -i -c "from src.server.repositories.implementations.supabase_database import SupabaseDatabase; db = SupabaseDatabase(); print('SupabaseDatabase instance available as: db')"

.PHONY: test-watch
test-watch: ## Run tests in watch mode (requires pytest-watch)
	uv run ptw tests/ -- -v --tb=short

.PHONY: update-deps
update-deps: ## Update all dependencies to latest versions
	uv lock --upgrade
	uv sync
	@echo "✅ Dependencies updated"

.PHONY: security-check
security-check: ## Check for security vulnerabilities
	uv run pip-audit
	@echo "✅ Security check completed"

# Repository Pattern specific targets
.PHONY: repo-test
repo-test: test-repo ## Alias for test-repo

.PHONY: repo-coverage
repo-coverage: test-repo-coverage ## Alias for test-repo-coverage

.PHONY: repo-check
repo-check: ## Run all repository pattern checks
	@echo "Running repository pattern checks..."
	uv run ruff check src/server/repositories/ --fix
	uv run mypy src/server/repositories/ --ignore-missing-imports
	uv run pytest tests/test_repository*.py -v --tb=short
	@echo "✅ Repository pattern checks completed"

# Development workflow shortcuts
.PHONY: dev
dev: format lint test ## Run development workflow (format, lint, test)
	@echo "✅ Development workflow completed"

.PHONY: ci
ci: clean check ## Run CI workflow (clean, check)
	@echo "✅ CI workflow completed"

.PHONY: pre-commit
pre-commit: format lint typecheck test-fast ## Run pre-commit checks
	@echo "✅ Pre-commit checks passed"

# Default target
.DEFAULT_GOAL := help