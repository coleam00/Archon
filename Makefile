# Archon Makefile - Simple, Secure, Cross-Platform
SHELL := /bin/bash
.SHELLFLAGS := -ec

# Docker compose command - prefer newer 'docker compose' plugin over standalone 'docker-compose'
COMPOSE ?= $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")

.PHONY: help dev dev-docker dev-docker-full dev-work-orders dev-hybrid-work-orders stop test test-fe test-be lint lint-fe lint-be clean install check agent-work-orders

help:
	@echo "Archon Development Commands"
	@echo "==========================="
	@echo "  make dev                    - Backend in Docker, frontend local (recommended)"
	@echo "  make dev-docker             - Backend + frontend in Docker"
	@echo "  make dev-docker-full        - Everything in Docker (server + mcp + ui + work orders)"
	@echo "  make dev-hybrid-work-orders - Server + MCP in Docker, UI + work orders local (2 terminals)"
	@echo "  make dev-work-orders        - Backend in Docker, agent work orders local, frontend local"
	@echo "  make agent-work-orders      - Run agent work orders service locally"
	@echo "  make stop                   - Stop all services"
	@echo "  make test                   - Run all tests"
	@echo "  make test-fe                - Run frontend tests only"
	@echo "  make test-be                - Run backend tests only"
	@echo "  make lint                   - Run all linters"
	@echo "  make lint-fe                - Run frontend linter only"
	@echo "  make lint-be                - Run backend linter only"
	@echo "  make clean                  - Remove containers and volumes"
	@echo "  make install                - Install dependencies"
	@echo "  make check                  - Check environment setup"

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

# Full Docker development (backend + frontend, no work orders)
dev-docker: check
	@echo "Starting Docker environment (backend + frontend)..."
	@$(COMPOSE) --profile full up -d --build
	@echo "✓ Services running"
	@echo "Frontend: http://localhost:3737"
	@echo "API: http://localhost:8181"

# Full Docker with all services (server + mcp + ui + agent work orders)
dev-docker-full: check
	@echo "Starting full Docker environment with agent work orders..."
	@$(COMPOSE) up archon-server archon-mcp archon-frontend archon-agent-work-orders -d --build
	@set -a; [ -f .env ] && . ./.env; set +a; \
	echo "✓ All services running"; \
	echo "Frontend: http://localhost:3737"; \
	echo "API: http://$${HOST:-localhost}:$${ARCHON_SERVER_PORT:-8181}"; \
	echo "MCP: http://$${HOST:-localhost}:$${ARCHON_MCP_PORT:-8051}"; \
	echo "Agent Work Orders: http://$${HOST:-localhost}:$${AGENT_WORK_ORDERS_PORT:-8053}"

# Agent work orders service locally (standalone)
agent-work-orders:
	@echo "Starting Agent Work Orders service locally..."
	@set -a; [ -f .env ] && . ./.env; set +a; \
	export SERVICE_DISCOVERY_MODE=local; \
	export ARCHON_SERVER_URL=http://localhost:$${ARCHON_SERVER_PORT:-8181}; \
	export ARCHON_MCP_URL=http://localhost:$${ARCHON_MCP_PORT:-8051}; \
	export AGENT_WORK_ORDERS_PORT=$${AGENT_WORK_ORDERS_PORT:-8053}; \
	cd python && uv run python -m uvicorn src.agent_work_orders.server:app --host 0.0.0.0 --port $${AGENT_WORK_ORDERS_PORT:-8053} --reload

# Hybrid development with agent work orders (backend in Docker, agent work orders local, frontend local)
dev-work-orders: check
	@echo "Starting hybrid development with agent work orders..."
	@echo "Backend: Docker | Agent Work Orders: Local | Frontend: Local"
	@$(COMPOSE) up archon-server archon-mcp -d --build
	@set -a; [ -f .env ] && . ./.env; set +a; \
	echo "Backend running at http://$${HOST:-localhost}:$${ARCHON_SERVER_PORT:-8181}"; \
	echo "Starting agent work orders service..."; \
	echo "Run in separate terminal: make agent-work-orders"; \
	echo "Starting frontend..."; \
	cd archon-ui-main && \
	VITE_ARCHON_SERVER_PORT=$${ARCHON_SERVER_PORT:-8181} \
	VITE_ARCHON_SERVER_HOST=$${HOST:-} \
	npm run dev

# Hybrid development: Server + MCP in Docker, UI + Work Orders local (requires 2 terminals)
dev-hybrid-work-orders: check
	@echo "Starting hybrid development: Server + MCP in Docker, UI + Work Orders local"
	@echo "================================================================"
	@$(COMPOSE) up archon-server archon-mcp -d --build
	@set -a; [ -f .env ] && . ./.env; set +a; \
	echo ""; \
	echo "✓ Server + MCP running in Docker"; \
	echo "  Server: http://$${HOST:-localhost}:$${ARCHON_SERVER_PORT:-8181}"; \
	echo "  MCP: http://$${HOST:-localhost}:$${ARCHON_MCP_PORT:-8051}"; \
	echo ""; \
	echo "Next steps:"; \
	echo "  1. Terminal 1 (this one): Press Ctrl+C when done"; \
	echo "  2. Terminal 2: make agent-work-orders"; \
	echo "  3. Terminal 3: cd archon-ui-main && npm run dev"; \
	echo ""; \
	echo "Or use 'make dev-docker-full' to run everything in Docker."; \
	@read -p "Press Enter to continue or Ctrl+C to stop..." _

# Stop all services
stop:
	@echo "Stopping all services..."
	@$(COMPOSE) --profile backend --profile frontend --profile full --profile work-orders down
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

.DEFAULT_GOAL := help
