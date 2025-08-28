# Docker Security Makefile
# Automation for security operations in the Archon project

# Configuration
SHELL := /bin/bash
PROJECT_ROOT := $(shell dirname $(CURDIR))
SECURITY_DIR := $(CURDIR)
SCRIPTS_DIR := $(PROJECT_ROOT)/scripts
REPORTS_DIR := $(SECURITY_DIR)/reports
TIMESTAMP := $(shell date +%Y%m%d_%H%M%S)

# Colors for output
RED := \033[0;31m
GREEN := \033[0;32m
YELLOW := \033[1;33m
BLUE := \033[0;34m
NC := \033[0m

# Default target
.DEFAULT_GOAL := help

# Create necessary directories
$(REPORTS_DIR):
	@mkdir -p $(REPORTS_DIR)

# Help target
.PHONY: help
help: ## Display this help message
	@echo -e "$(BLUE)Docker Security Makefile$(NC)"
	@echo -e "$(BLUE)=========================$(NC)"
	@echo ""
	@echo "Available targets:"
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""
	@echo "Examples:"
	@echo -e "  $(YELLOW)make security-scan$(NC)     # Run comprehensive security scan"
	@echo -e "  $(YELLOW)make build-secure$(NC)      # Build all containers with security"
	@echo -e "  $(YELLOW)make test-security$(NC)     # Test security configurations"

# Install security tools
.PHONY: install-tools
install-tools: ## Install required security tools
	@echo -e "$(BLUE)Installing security tools...$(NC)"
	@$(SCRIPTS_DIR)/security-scan.sh install-tools || echo -e "$(YELLOW)Manual installation required$(NC)"

# Run comprehensive security scan
.PHONY: security-scan
security-scan: $(REPORTS_DIR) ## Run comprehensive security scan
	@echo -e "$(BLUE)Running comprehensive security scan...$(NC)"
	@$(SCRIPTS_DIR)/security-scan.sh
	@echo -e "$(GREEN)Security scan complete. Check $(REPORTS_DIR)$(NC)"

# Scan Dockerfiles
.PHONY: scan-dockerfiles
scan-dockerfiles: $(REPORTS_DIR) ## Scan all Dockerfiles with Hadolint
	@echo -e "$(BLUE)Scanning Dockerfiles...$(NC)"
	@if command -v hadolint >/dev/null 2>&1; then \
		find $(PROJECT_ROOT) -name "Dockerfile*" -type f | while read dockerfile; do \
			echo -e "Scanning: $${dockerfile#$(PROJECT_ROOT)/}"; \
			hadolint "$$dockerfile" || true; \
		done > $(REPORTS_DIR)/dockerfile_scan_$(TIMESTAMP).log; \
		echo -e "$(GREEN)Dockerfile scan complete$(NC)"; \
	else \
		echo -e "$(RED)Hadolint not installed. Run 'make install-tools' first$(NC)"; \
		exit 1; \
	fi

# Scan Docker images
.PHONY: scan-images
scan-images: $(REPORTS_DIR) ## Scan Docker images for vulnerabilities
	@echo -e "$(BLUE)Scanning Docker images...$(NC)"
	@if command -v trivy >/dev/null 2>&1; then \
		docker images --format "{{.Repository}}:{{.Tag}}" | grep -v "<none>" | head -10 | while read image; do \
			echo -e "Scanning image: $$image"; \
			trivy image --severity HIGH,CRITICAL "$$image" > $(REPORTS_DIR)/image_$$(echo "$$image" | tr ':/' '__')_$(TIMESTAMP).log 2>&1 || true; \
		done; \
		echo -e "$(GREEN)Image scan complete$(NC)"; \
	else \
		echo -e "$(RED)Trivy not installed. Run 'make install-tools' first$(NC)"; \
		exit 1; \
	fi

# Build all containers with security
.PHONY: build-secure
build-secure: ## Build all containers with security hardening
	@echo -e "$(BLUE)Building containers with security hardening...$(NC)"
	@cd $(PROJECT_ROOT) && docker-compose build --no-cache
	@echo -e "$(GREEN)Secure build complete$(NC)"

# Test security configurations
.PHONY: test-security
test-security: ## Test security configurations of running containers
	@echo -e "$(BLUE)Testing security configurations...$(NC)"
	@$(SCRIPTS_DIR)/security-scan.sh test-running || echo -e "$(YELLOW)No running containers to test$(NC)"

# Start containers in security mode
.PHONY: start-secure
start-secure: ## Start containers with security profiles
	@echo -e "$(BLUE)Starting containers with security profiles...$(NC)"
	@cd $(PROJECT_ROOT) && docker-compose --profile full up -d
	@echo -e "$(GREEN)Secure containers started$(NC)"

# Stop and clean containers
.PHONY: stop-clean
stop-clean: ## Stop containers and clean up
	@echo -e "$(BLUE)Stopping containers and cleaning up...$(NC)"
	@cd $(PROJECT_ROOT) && docker-compose down --remove-orphans
	@docker system prune -f
	@echo -e "$(GREEN)Cleanup complete$(NC)"

# Setup artifact security
.PHONY: setup-artifacts
setup-artifacts: ## Setup secure artifact handling
	@echo -e "$(BLUE)Setting up secure artifact handling...$(NC)"
	@$(SECURITY_DIR)/artifact-security.sh setup
	@echo -e "$(GREEN)Artifact security setup complete$(NC)"

# Generate security report
.PHONY: security-report
security-report: $(REPORTS_DIR) ## Generate comprehensive security report
	@echo -e "$(BLUE)Generating security report...$(NC)"
	@$(SECURITY_DIR)/artifact-security.sh report
	@$(SCRIPTS_DIR)/security-scan.sh generate-summary
	@echo -e "$(GREEN)Security report generated in $(REPORTS_DIR)$(NC)"

# Monitor containers for security events
.PHONY: monitor-security
monitor-security: ## Start security monitoring of containers
	@echo -e "$(BLUE)Starting security monitoring...$(NC)"
	@$(SECURITY_DIR)/artifact-security.sh monitor &
	@echo -e "$(GREEN)Security monitoring started$(NC)"

# Validate container security
.PHONY: validate-security
validate-security: ## Validate current security posture
	@echo -e "$(BLUE)Validating container security...$(NC)"
	@failed=0; \
	echo "Checking running containers..."; \
	for container in $$(docker ps --format "{{.Names}}"); do \
		echo -e "Validating: $$container"; \
		user=$$(docker exec $$container whoami 2>/dev/null || echo "unknown"); \
		if [ "$$user" = "root" ]; then \
			echo -e "$(RED)✗ $$container running as root$(NC)"; \
			failed=1; \
		else \
			echo -e "$(GREEN)✓ $$container running as: $$user$(NC)"; \
		fi; \
	done; \
	if [ $$failed -eq 1 ]; then \
		echo -e "$(RED)Security validation failed$(NC)"; \
		exit 1; \
	else \
		echo -e "$(GREEN)Security validation passed$(NC)"; \
	fi

# Clean old reports
.PHONY: clean-reports
clean-reports: ## Clean old security reports (keep last 10)
	@echo -e "$(BLUE)Cleaning old security reports...$(NC)"
	@if [ -d "$(REPORTS_DIR)" ]; then \
		find $(REPORTS_DIR) -name "*.log" -type f | sort | head -n -10 | xargs rm -f || true; \
		find $(REPORTS_DIR) -name "*.json" -type f | sort | head -n -10 | xargs rm -f || true; \
		find $(REPORTS_DIR) -name "*.md" -type f | sort | head -n -10 | xargs rm -f || true; \
		echo -e "$(GREEN)Old reports cleaned$(NC)"; \
	else \
		echo -e "$(YELLOW)No reports directory found$(NC)"; \
	fi

# Benchmark security
.PHONY: benchmark-security
benchmark-security: $(REPORTS_DIR) ## Run Docker security benchmark
	@echo -e "$(BLUE)Running Docker security benchmark...$(NC)"
	@if [ -d "$(SECURITY_DIR)/docker-bench-security" ]; then \
		cd $(SECURITY_DIR)/docker-bench-security && \
		sudo ./docker-bench-security.sh -l $(REPORTS_DIR)/benchmark_$(TIMESTAMP).log; \
		echo -e "$(GREEN)Security benchmark complete$(NC)"; \
	else \
		echo -e "$(YELLOW)Docker Bench Security not found. Run 'make install-tools' first$(NC)"; \
	fi

# Update security tools
.PHONY: update-tools
update-tools: ## Update security tools to latest versions
	@echo -e "$(BLUE)Updating security tools...$(NC)"
	@if command -v trivy >/dev/null 2>&1; then \
		echo "Updating Trivy database..."; \
		trivy image --download-db-only; \
	fi
	@if [ -d "$(SECURITY_DIR)/docker-bench-security" ]; then \
		echo "Updating Docker Bench Security..."; \
		cd $(SECURITY_DIR)/docker-bench-security && git pull; \
	fi
	@echo -e "$(GREEN)Security tools updated$(NC)"

# CI/CD Integration targets
.PHONY: ci-security-check
ci-security-check: ## Run security checks for CI/CD pipeline
	@echo -e "$(BLUE)Running CI/CD security checks...$(NC)"
	@make scan-dockerfiles
	@make validate-security
	@echo -e "$(GREEN)CI/CD security checks complete$(NC)"

.PHONY: pre-commit-security
pre-commit-security: ## Run security checks before commit
	@echo -e "$(BLUE)Running pre-commit security checks...$(NC)"
	@make scan-dockerfiles
	@echo -e "$(GREEN)Pre-commit security checks complete$(NC)"

# Full security pipeline
.PHONY: full-security-pipeline
full-security-pipeline: ## Run complete security pipeline
	@echo -e "$(BLUE)Running full security pipeline...$(NC)"
	@make clean-reports
	@make install-tools
	@make scan-dockerfiles
	@make build-secure
	@make scan-images
	@make validate-security
	@make security-report
	@echo -e "$(GREEN)Full security pipeline complete$(NC)"

# Emergency security stop
.PHONY: security-emergency-stop
security-emergency-stop: ## Emergency stop all containers (security incident)
	@echo -e "$(RED)EMERGENCY: Stopping all containers immediately$(NC)"
	@docker stop $$(docker ps -q) 2>/dev/null || true
	@docker system prune -af
	@echo -e "$(RED)All containers stopped and cleaned$(NC)"

# Show current security status
.PHONY: security-status
security-status: ## Show current security status
	@echo -e "$(BLUE)Current Security Status$(NC)"
	@echo -e "$(BLUE)======================$(NC)"
	@echo ""
	@echo -e "$(YELLOW)Running Containers:$(NC)"
	@docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" || echo "No containers running"
	@echo ""
	@echo -e "$(YELLOW)Security Tools Status:$(NC)"
	@echo -n "Trivy: "; command -v trivy >/dev/null 2>&1 && echo -e "$(GREEN)✓ Installed$(NC)" || echo -e "$(RED)✗ Not installed$(NC)"
	@echo -n "Hadolint: "; command -v hadolint >/dev/null 2>&1 && echo -e "$(GREEN)✓ Installed$(NC)" || echo -e "$(RED)✗ Not installed$(NC)"
	@echo -n "Docker Bench: "; [ -d "$(SECURITY_DIR)/docker-bench-security" ] && echo -e "$(GREEN)✓ Available$(NC)" || echo -e "$(RED)✗ Not available$(NC)"
	@echo ""
	@echo -e "$(YELLOW)Recent Reports:$(NC)"
	@if [ -d "$(REPORTS_DIR)" ]; then \
		ls -lt $(REPORTS_DIR)/*.{log,json,md} 2>/dev/null | head -5 || echo "No reports found"; \
	else \
		echo "No reports directory"; \
	fi