# Archon Makefile - Simple, Secure, Cross-Platform
SHELL := /bin/bash
.SHELLFLAGS := -ec

# Docker compose command - prefer newer 'docker compose' plugin over standalone 'docker-compose'
COMPOSE ?= $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")

.PHONY: help dev dev-docker stop test test-fe test-be lint lint-fe lint-be clean install check logs logs-backend logs-all logs-clear

help:
	@echo "Archon Development Commands"
	@echo "==========================="
	@echo "  make dev        - Backend in Docker, frontend local (recommended)"
	@echo "  make dev-docker - Everything in Docker"
	@echo "  make stop       - Stop all services"
	@echo "  make test       - Run all tests"
	@echo "  make test-fe    - Run frontend tests only"
	@echo "  make test-be    - Run backend tests only"
	@echo "  make lint       - Run all linters"
	@echo "  make lint-fe    - Run frontend linter only"
	@echo "  make lint-be    - Run backend linter only"
	@echo "  make clean      - Remove containers and volumes"
	@echo "  make install    - Install dependencies"
	@echo "  make check      - Check environment setup"
	@echo ""
	@echo "  Logging Commands:"
	@echo "  make logs       - Follow all container logs"
	@echo "  make logs-backend - Follow backend logs only"
	@echo "  make logs-all   - Show all logs from container start"
	@echo "  make logs-clear - Clear terminal and follow logs"

# Install dependencies
install:
	@echo "Installing dependencies..."
	@cd archon-ui-main && npm install
	@cd python && uv sync --group all --group dev
	@echo "✓ Dependencies installed"

# Check environment
check:
	@echo "Checking environment..."
	@node -v >/dev/null 2>&1 || { echo "✗ Node.js not found (require Node 18+)."; exit 1; }
	@node check-env.js
	@echo "Checking Docker..."
	@docker --version > /dev/null 2>&1 || { echo "✗ Docker not found"; exit 1; }
	@$(COMPOSE) version > /dev/null 2>&1 || { echo "✗ Docker Compose not found"; exit 1; }
	@echo "✓ Environment OK"


# Hybrid development (recommended)
dev: check
	@echo "Starting hybrid development..."
	@echo "Backend: Docker | Frontend: Local with hot reload"
	@$(COMPOSE) --profile backend up -d --build
	@set -a; [ -f .env ] && . ./.env; set +a; \
	echo "Backend running at http://$${HOST:-localhost}:$${ARCHON_SERVER_PORT:-8181}"
	@echo "Starting frontend..."
	@cd archon-ui-main && \
	VITE_ARCHON_SERVER_PORT=$${ARCHON_SERVER_PORT:-8181} \
	VITE_ARCHON_SERVER_HOST=$${HOST:-} \
	npm run dev

# Full Docker development
dev-docker: check
	@echo "Starting full Docker environment..."
	@$(COMPOSE) --profile full up -d --build
	@echo "✓ All services running"
	@echo "Frontend: http://localhost:3737"
	@echo "API: http://localhost:8181"

# Stop all services
stop:
	@echo "Stopping all services..."
	@$(COMPOSE) --profile backend --profile frontend --profile full down
	@echo "✓ Services stopped"

# Run all tests
test: test-fe test-be

# Run frontend tests
test-fe:
	@echo "Running frontend tests..."
	@cd archon-ui-main && npm test

# Run backend tests
test-be:
	@echo "Running backend tests..."
	@cd python && uv run pytest

# Run all linters
lint: lint-fe lint-be

# Run frontend linter
lint-fe:
	@echo "Linting frontend..."
	@cd archon-ui-main && npm run lint

# Run backend linter
lint-be:
	@echo "Linting backend..."
	@cd python && uv run ruff check --fix

# Clean everything (with confirmation)
clean:
	@echo "⚠️  This will remove all containers and volumes"
	@read -p "Are you sure? (y/N) " -n 1 -r; \
	echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		$(COMPOSE) down -v --remove-orphans; \
		echo "✓ Cleaned"; \
	else \
		echo "Cancelled"; \
	fi

# Logging commands
logs:
	@echo "📜 Following all container logs (Ctrl+C to stop)..."
	@$(COMPOSE) logs -f --tail=100

logs-backend:
	@echo "📜 Following backend logs (Ctrl+C to stop)..."
	@$(COMPOSE) logs -f --tail=100 archon-backend

logs-all:
	@echo "📜 Showing all logs from container start..."
	@$(COMPOSE) logs -f

logs-clear:
	@clear
	@echo "📜 Following all container logs (Ctrl+C to stop)..."
	@$(COMPOSE) logs -f --tail=50

.DEFAULT_GOAL := help
