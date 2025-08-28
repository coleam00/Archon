#!/bin/bash

# Docker Security Scanner Script
# This script performs comprehensive security scanning of all Docker containers
# and generates detailed security reports

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SECURITY_DIR="$PROJECT_ROOT/security"
REPORTS_DIR="$SECURITY_DIR/reports"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Create reports directory
create_reports_dir() {
    mkdir -p "$REPORTS_DIR"
    log "Created reports directory: $REPORTS_DIR"
}

# Check if required tools are installed
check_dependencies() {
    local missing_tools=()
    
    # Check for required security tools
    if ! command -v trivy &> /dev/null; then
        missing_tools+=("trivy")
    fi
    
    if ! command -v docker &> /dev/null; then
        missing_tools+=("docker")
    fi
    
    if ! command -v hadolint &> /dev/null; then
        missing_tools+=("hadolint")
    fi
    
    if [ ${#missing_tools[@]} -ne 0 ]; then
        error "Missing required tools: ${missing_tools[*]}"
        error "Please install missing tools before running security scan"
        exit 1
    fi
    
    success "All required tools are available"
}

# Install security tools if not present
install_security_tools() {
    log "Checking and installing security tools..."
    
    # Install Trivy if not present
    if ! command -v trivy &> /dev/null; then
        log "Installing Trivy..."
        if [[ "$OSTYPE" == "linux-gnu"* ]]; then
            # Linux installation
            curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sudo sh -s -- -b /usr/local/bin v0.48.3
        elif [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS installation
            brew install trivy
        else
            warning "Please install Trivy manually for your operating system"
        fi
    fi
    
    # Install Hadolint if not present
    if ! command -v hadolint &> /dev/null; then
        log "Installing Hadolint..."
        if [[ "$OSTYPE" == "linux-gnu"* ]]; then
            wget -O /tmp/hadolint "https://github.com/hadolint/hadolint/releases/download/v2.12.0/hadolint-Linux-x86_64"
            chmod +x /tmp/hadolint
            sudo mv /tmp/hadolint /usr/local/bin/
        elif [[ "$OSTYPE" == "darwin"* ]]; then
            brew install hadolint
        else
            warning "Please install Hadolint manually for your operating system"
        fi
    fi
    
    # Install Docker Bench Security
    if [ ! -d "$SECURITY_DIR/docker-bench-security" ]; then
        log "Cloning Docker Bench Security..."
        git clone https://github.com/docker/docker-bench-security.git "$SECURITY_DIR/docker-bench-security"
    fi
    
    success "Security tools installation complete"
}

# Scan Dockerfiles with Hadolint
scan_dockerfiles() {
    log "Scanning Dockerfiles with Hadolint..."
    
    local dockerfile_report="$REPORTS_DIR/hadolint_report_$TIMESTAMP.json"
    local dockerfiles=()
    
    # Find all Dockerfiles
    while IFS= read -r -d '' dockerfile; do
        dockerfiles+=("$dockerfile")
    done < <(find "$PROJECT_ROOT" -name "Dockerfile*" -type f -print0)
    
    if [ ${#dockerfiles[@]} -eq 0 ]; then
        warning "No Dockerfiles found"
        return
    fi
    
    log "Found ${#dockerfiles[@]} Dockerfiles to scan"
    
    # Scan each Dockerfile
    echo "[]" > "$dockerfile_report"
    for dockerfile in "${dockerfiles[@]}"; do
        local relative_path="${dockerfile#$PROJECT_ROOT/}"
        log "Scanning: $relative_path"
        
        if hadolint --format json "$dockerfile" > "/tmp/hadolint_${TIMESTAMP}.json" 2>/dev/null; then
            success "✓ $relative_path - No issues found"
        else
            warning "! $relative_path - Issues found"
            # Merge results into main report
            jq -s ".[0] + [{\"file\": \"$relative_path\", \"issues\": .[1]}]" "$dockerfile_report" "/tmp/hadolint_${TIMESTAMP}.json" > "/tmp/merged_${TIMESTAMP}.json"
            mv "/tmp/merged_${TIMESTAMP}.json" "$dockerfile_report"
        fi
    done
    
    success "Dockerfile scan complete. Report saved to: $dockerfile_report"
}

# Scan Docker images with Trivy
scan_images() {
    log "Scanning Docker images with Trivy..."
    
    local image_report="$REPORTS_DIR/trivy_images_$TIMESTAMP.json"
    local images=()
    
    # Get list of local images
    mapfile -t images < <(docker images --format "{{.Repository}}:{{.Tag}}" | grep -v "<none>" | head -20)
    
    if [ ${#images[@]} -eq 0 ]; then
        warning "No Docker images found to scan"
        return
    fi
    
    log "Found ${#images[@]} images to scan"
    
    # Initialize report
    echo "{\"scans\": []}" > "$image_report"
    
    # Scan each image
    for image in "${images[@]}"; do
        log "Scanning image: $image"
        
        local temp_scan="/tmp/trivy_${TIMESTAMP}_$(echo "$image" | tr ':/' '__').json"
        
        if trivy image --format json --severity HIGH,CRITICAL "$image" > "$temp_scan" 2>/dev/null; then
            # Count vulnerabilities
            local vuln_count=$(jq '[.Results[]? | .Vulnerabilities[]?] | length' "$temp_scan" 2>/dev/null || echo "0")
            
            if [ "$vuln_count" -eq 0 ]; then
                success "✓ $image - No high/critical vulnerabilities found"
            else
                warning "! $image - Found $vuln_count high/critical vulnerabilities"
            fi
            
            # Merge into main report
            jq --arg image "$image" '.scans += [{"image": $image, "result": .}]' "$image_report" "$temp_scan" > "/tmp/merged_${TIMESTAMP}.json"
            mv "/tmp/merged_${TIMESTAMP}.json" "$image_report"
        else
            error "Failed to scan image: $image"
        fi
    done
    
    success "Image scan complete. Report saved to: $image_report"
}

# Run Docker Bench Security
run_docker_bench() {
    log "Running Docker Bench Security..."
    
    if [ ! -d "$SECURITY_DIR/docker-bench-security" ]; then
        warning "Docker Bench Security not found. Skipping..."
        return
    fi
    
    local bench_report="$REPORTS_DIR/docker_bench_$TIMESTAMP.log"
    
    cd "$SECURITY_DIR/docker-bench-security"
    
    if sudo ./docker-bench-security.sh -l "$bench_report" 2>/dev/null; then
        success "Docker Bench Security scan complete. Report saved to: $bench_report"
    else
        error "Docker Bench Security scan failed"
    fi
    
    cd "$PROJECT_ROOT"
}

# Scan running containers
scan_running_containers() {
    log "Scanning running containers..."
    
    local running_containers=()
    mapfile -t running_containers < <(docker ps --format "{{.Names}}")
    
    if [ ${#running_containers[@]} -eq 0 ]; then
        warning "No running containers found"
        return
    fi
    
    log "Found ${#running_containers[@]} running containers"
    
    local container_report="$REPORTS_DIR/container_security_$TIMESTAMP.json"
    echo "{\"containers\": []}" > "$container_report"
    
    for container in "${running_containers[@]}"; do
        log "Analyzing container: $container"
        
        # Get container info
        local container_info=$(docker inspect "$container" 2>/dev/null || echo "{}")
        local is_privileged=$(echo "$container_info" | jq -r '.[0].HostConfig.Privileged // false')
        local user=$(echo "$container_info" | jq -r '.[0].Config.User // "root"')
        local readonly_rootfs=$(echo "$container_info" | jq -r '.[0].HostConfig.ReadonlyRootfs // false')
        
        # Check security configurations
        local security_issues=()
        
        if [ "$is_privileged" = "true" ]; then
            security_issues+=("Running in privileged mode")
        fi
        
        if [ "$user" = "root" ] || [ "$user" = "" ]; then
            security_issues+=("Running as root user")
        fi
        
        if [ "$readonly_rootfs" = "false" ]; then
            security_issues+=("Root filesystem is not read-only")
        fi
        
        # Report findings
        if [ ${#security_issues[@]} -eq 0 ]; then
            success "✓ $container - Security configuration looks good"
        else
            warning "! $container - Security issues found: ${#security_issues[@]}"
            for issue in "${security_issues[@]}"; do
                warning "  - $issue"
            done
        fi
        
        # Add to report
        local container_data=$(jq -n \
            --arg name "$container" \
            --arg user "$user" \
            --argjson privileged "$is_privileged" \
            --argjson readonly "$readonly_rootfs" \
            --argjson issues "$(printf '%s\n' "${security_issues[@]}" | jq -R . | jq -s .)" \
            '{
                name: $name,
                user: $user,
                privileged: $privileged,
                readonly_rootfs: $readonly,
                security_issues: $issues
            }'
        )
        
        jq --argjson container "$container_data" '.containers += [$container]' "$container_report" > "/tmp/temp_container_${TIMESTAMP}.json"
        mv "/tmp/temp_container_${TIMESTAMP}.json" "$container_report"
    done
    
    success "Container analysis complete. Report saved to: $container_report"
}

# Generate summary report
generate_summary() {
    log "Generating security summary report..."
    
    local summary_report="$REPORTS_DIR/security_summary_$TIMESTAMP.md"
    
    cat > "$summary_report" << EOF
# Docker Security Scan Summary

**Scan Date:** $(date)  
**Scan ID:** $TIMESTAMP

## Overview

This report provides a comprehensive security analysis of the Archon project's Docker containers and configurations.

## Scan Results

### Dockerfile Security (Hadolint)

EOF

    # Add Dockerfile results if available
    local dockerfile_report="$REPORTS_DIR/hadolint_report_$TIMESTAMP.json"
    if [ -f "$dockerfile_report" ]; then
        local dockerfile_count=$(jq 'length' "$dockerfile_report")
        echo "- **Dockerfiles scanned:** $dockerfile_count" >> "$summary_report"
        echo "- **Report file:** $(basename "$dockerfile_report")" >> "$summary_report"
        echo "" >> "$summary_report"
    fi

    cat >> "$summary_report" << EOF
### Image Vulnerabilities (Trivy)

EOF

    # Add image scan results if available
    local image_report="$REPORTS_DIR/trivy_images_$TIMESTAMP.json"
    if [ -f "$image_report" ]; then
        local image_count=$(jq '.scans | length' "$image_report" 2>/dev/null || echo "0")
        echo "- **Images scanned:** $image_count" >> "$summary_report"
        echo "- **Report file:** $(basename "$image_report")" >> "$summary_report"
        echo "" >> "$summary_report"
    fi

    cat >> "$summary_report" << EOF
### Container Runtime Security

EOF

    # Add container scan results if available
    local container_report="$REPORTS_DIR/container_security_$TIMESTAMP.json"
    if [ -f "$container_report" ]; then
        local container_count=$(jq '.containers | length' "$container_report" 2>/dev/null || echo "0")
        echo "- **Running containers analyzed:** $container_count" >> "$summary_report"
        echo "- **Report file:** $(basename "$container_report")" >> "$summary_report"
        echo "" >> "$summary_report"
    fi

    cat >> "$summary_report" << EOF
## Security Recommendations

1. **Ensure all containers run as non-root users**
2. **Use read-only root filesystems where possible**
3. **Drop all unnecessary Linux capabilities**
4. **Regular vulnerability scanning and patching**
5. **Monitor container runtime behavior**

## Next Steps

1. Review detailed reports in the security/reports directory
2. Address any high or critical vulnerabilities found
3. Implement recommended security configurations
4. Schedule regular security scans

---
*Generated by Archon Security Scanner*
EOF

    success "Summary report generated: $summary_report"
}

# Main execution
main() {
    log "Starting Docker Security Scan for Archon Project"
    log "=================================================="
    
    create_reports_dir
    install_security_tools
    check_dependencies
    
    log "Starting security scans..."
    scan_dockerfiles
    scan_images
    run_docker_bench
    scan_running_containers
    generate_summary
    
    log "=================================================="
    success "Security scan complete! Check reports in: $REPORTS_DIR"
    log "Summary report: $REPORTS_DIR/security_summary_$TIMESTAMP.md"
}

# Run main function if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi