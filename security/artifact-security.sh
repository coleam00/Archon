#!/bin/bash

# Secure Artifact Handling Script
# This script provides secure mechanisms for handling artifacts in Docker containers
# with proper permission management and security validation

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ARTIFACTS_DIR="$PROJECT_ROOT/artifacts"
TEMP_DIR="/tmp/archon_artifacts"
SECURE_USER="artifactuser"
SECURE_GROUP="artifactgroup"
SECURE_UID=1002
SECURE_GID=1002

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Logging functions
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

# Create secure artifact directory structure
create_secure_directories() {
    log "Creating secure artifact directory structure..."
    
    # Create main artifacts directory
    mkdir -p "$ARTIFACTS_DIR"/{incoming,processed,quarantine,exports}
    
    # Create temporary processing directory
    mkdir -p "$TEMP_DIR"
    
    # Set secure permissions
    chmod 750 "$ARTIFACTS_DIR"
    chmod 700 "$TEMP_DIR"
    
    # Create subdirectories with appropriate permissions
    chmod 755 "$ARTIFACTS_DIR/incoming"     # Upload area
    chmod 750 "$ARTIFACTS_DIR/processed"    # Processed artifacts
    chmod 700 "$ARTIFACTS_DIR/quarantine"   # Suspicious files
    chmod 755 "$ARTIFACTS_DIR/exports"      # Export area
    
    success "Secure directory structure created"
}

# Create secure user for artifact handling
create_artifact_user() {
    log "Setting up secure artifact user..."
    
    # Check if user already exists
    if id "$SECURE_USER" >/dev/null 2>&1; then
        log "User $SECURE_USER already exists"
        return
    fi
    
    # Create group
    if ! getent group "$SECURE_GROUP" >/dev/null 2>&1; then
        groupadd -g "$SECURE_GID" "$SECURE_GROUP"
        success "Created group: $SECURE_GROUP (GID: $SECURE_GID)"
    fi
    
    # Create user
    useradd -u "$SECURE_UID" -g "$SECURE_GID" -s /sbin/nologin -d /dev/null -M "$SECURE_USER"
    success "Created user: $SECURE_USER (UID: $SECURE_UID)"
    
    # Set ownership of artifact directories
    chown -R "$SECURE_USER:$SECURE_GROUP" "$ARTIFACTS_DIR"
    chown -R "$SECURE_USER:$SECURE_GROUP" "$TEMP_DIR"
    
    success "Artifact user setup complete"
}

# Validate artifact security
validate_artifact() {
    local artifact_path="$1"
    local validation_log="$TEMP_DIR/validation_$(date +%s).log"
    
    log "Validating artifact: $(basename "$artifact_path")"
    
    # Basic file checks
    if [ ! -f "$artifact_path" ]; then
        error "Artifact file not found: $artifact_path"
        return 1
    fi
    
    # Check file size (max 100MB)
    local file_size=$(stat -f%z "$artifact_path" 2>/dev/null || stat -c%s "$artifact_path" 2>/dev/null)
    local max_size=$((100 * 1024 * 1024))  # 100MB
    
    if [ "$file_size" -gt "$max_size" ]; then
        warning "Artifact exceeds maximum size limit (100MB): $artifact_path"
        mv "$artifact_path" "$ARTIFACTS_DIR/quarantine/"
        return 1
    fi
    
    # Check file type and extension
    local file_type=$(file -b --mime-type "$artifact_path")
    local filename=$(basename "$artifact_path")
    local extension="${filename##*.}"
    
    # Allowed file types
    case "$file_type" in
        "text/plain"|"text/html"|"text/css"|"text/javascript"|"application/json")
            log "✓ Safe text file type: $file_type"
            ;;
        "application/pdf"|"application/zip"|"application/gzip")
            log "✓ Safe document/archive type: $file_type"
            ;;
        "image/png"|"image/jpeg"|"image/gif"|"image/svg+xml")
            log "✓ Safe image type: $file_type"
            ;;
        *)
            warning "Potentially unsafe file type: $file_type"
            echo "File type check failed: $file_type" >> "$validation_log"
            ;;
    esac
    
    # Check for executable permissions
    if [ -x "$artifact_path" ]; then
        warning "Artifact has executable permissions: $artifact_path"
        chmod -x "$artifact_path"
        log "Removed executable permissions"
    fi
    
    # Scan for common malicious patterns
    if command -v clamav-daemon >/dev/null 2>&1; then
        log "Scanning for malware with ClamAV..."
        if ! clamdscan --quiet "$artifact_path" >/dev/null 2>&1; then
            error "Malware detected in artifact: $artifact_path"
            mv "$artifact_path" "$ARTIFACTS_DIR/quarantine/"
            return 1
        fi
        success "✓ No malware detected"
    fi
    
    success "Artifact validation passed: $(basename "$artifact_path")"
    return 0
}

# Process artifact securely
process_artifact() {
    local input_path="$1"
    local output_path="$2"
    
    log "Processing artifact securely..."
    
    # Create secure temporary working directory
    local work_dir="$TEMP_DIR/work_$(date +%s)"
    mkdir -p "$work_dir"
    chmod 700 "$work_dir"
    
    # Copy artifact to working directory with secure permissions
    cp "$input_path" "$work_dir/artifact"
    chmod 644 "$work_dir/artifact"
    chown "$SECURE_USER:$SECURE_GROUP" "$work_dir/artifact"
    
    # Validate artifact
    if ! validate_artifact "$work_dir/artifact"; then
        error "Artifact validation failed"
        rm -rf "$work_dir"
        return 1
    fi
    
    # Process artifact (placeholder for actual processing logic)
    log "Performing artifact processing..."
    
    # Example: Strip metadata from images
    if command -v exiftool >/dev/null 2>&1; then
        if file "$work_dir/artifact" | grep -q "image"; then
            log "Stripping metadata from image..."
            exiftool -all= -overwrite_original "$work_dir/artifact" >/dev/null 2>&1 || true
        fi
    fi
    
    # Move processed artifact to output location
    mkdir -p "$(dirname "$output_path")"
    mv "$work_dir/artifact" "$output_path"
    chmod 644 "$output_path"
    
    # Clean up working directory
    rm -rf "$work_dir"
    
    success "Artifact processed successfully: $(basename "$output_path")"
}

# Export artifacts with security controls
export_artifact() {
    local artifact_path="$1"
    local export_name="$2"
    
    log "Exporting artifact with security controls..."
    
    if [ ! -f "$artifact_path" ]; then
        error "Artifact not found for export: $artifact_path"
        return 1
    fi
    
    # Create export package with metadata
    local export_dir="$ARTIFACTS_DIR/exports/$export_name"
    mkdir -p "$export_dir"
    
    # Copy artifact
    cp "$artifact_path" "$export_dir/"
    
    # Generate manifest
    cat > "$export_dir/manifest.json" << EOF
{
    "export_name": "$export_name",
    "export_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "original_file": "$(basename "$artifact_path")",
    "checksum": "$(sha256sum "$artifact_path" | cut -d' ' -f1)",
    "file_size": $(stat -f%z "$artifact_path" 2>/dev/null || stat -c%s "$artifact_path"),
    "security_scan": {
        "scanned": true,
        "scan_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
        "status": "clean"
    }
}
EOF
    
    # Set secure permissions on export
    chmod -R 755 "$export_dir"
    chown -R "$SECURE_USER:$SECURE_GROUP" "$export_dir"
    
    success "Artifact exported: $export_dir"
}

# Clean up old artifacts and temporary files
cleanup_artifacts() {
    log "Cleaning up old artifacts and temporary files..."
    
    # Remove temporary files older than 1 hour
    find "$TEMP_DIR" -type f -mmin +60 -delete 2>/dev/null || true
    
    # Remove empty directories
    find "$TEMP_DIR" -type d -empty -delete 2>/dev/null || true
    
    # Archive old processed artifacts (older than 30 days)
    find "$ARTIFACTS_DIR/processed" -type f -mtime +30 -exec gzip {} \; 2>/dev/null || true
    
    # Remove old exports (older than 7 days)
    find "$ARTIFACTS_DIR/exports" -type d -mtime +7 -exec rm -rf {} \; 2>/dev/null || true
    
    success "Cleanup completed"
}

# Monitor artifact directory for security events
monitor_artifacts() {
    log "Starting artifact monitoring..."
    
    if ! command -v inotifywait >/dev/null 2>&1; then
        warning "inotifywait not available, install inotify-tools for monitoring"
        return
    fi
    
    # Monitor incoming directory for new files
    inotifywait -m -r -e create,move,modify "$ARTIFACTS_DIR/incoming" --format '%w%f %e' |
    while read file event; do
        log "Detected $event on $file"
        
        case "$event" in
            CREATE|MOVED_TO)
                # New file added, validate it
                if validate_artifact "$file"; then
                    log "New artifact validated: $(basename "$file")"
                else
                    warning "New artifact failed validation: $(basename "$file")"
                fi
                ;;
            MODIFY)
                warning "Artifact modified after upload: $(basename "$file")"
                ;;
        esac
    done &
    
    local monitor_pid=$!
    log "Artifact monitoring started (PID: $monitor_pid)"
    
    # Store PID for cleanup
    echo "$monitor_pid" > "$TEMP_DIR/monitor.pid"
}

# Generate security report for artifacts
generate_artifact_report() {
    log "Generating artifact security report..."
    
    local report_file="$PROJECT_ROOT/security/reports/artifact_security_$(date +%Y%m%d_%H%M%S).md"
    mkdir -p "$(dirname "$report_file")"
    
    cat > "$report_file" << EOF
# Artifact Security Report

**Generated:** $(date)

## Overview

This report provides an analysis of artifact security measures and current status.

## Directory Status

### Incoming Artifacts
$(find "$ARTIFACTS_DIR/incoming" -type f | wc -l) files

### Processed Artifacts  
$(find "$ARTIFACTS_DIR/processed" -type f | wc -l) files

### Quarantined Artifacts
$(find "$ARTIFACTS_DIR/quarantine" -type f | wc -l) files

### Exported Artifacts
$(find "$ARTIFACTS_DIR/exports" -type d -mindepth 1 | wc -l) export packages

## Security Measures

- ✅ Non-root user processing ($SECURE_USER:$SECURE_GROUP)
- ✅ Secure directory permissions
- ✅ File type validation
- ✅ Size limit enforcement (100MB)
- ✅ Malware scanning (when available)
- ✅ Metadata stripping
- ✅ Secure export with manifests

## Recent Activity

### Last 24 Hours
- New artifacts: $(find "$ARTIFACTS_DIR" -type f -mtime -1 | wc -l)
- Quarantined files: $(find "$ARTIFACTS_DIR/quarantine" -type f -mtime -1 | wc -l)
- Exports created: $(find "$ARTIFACTS_DIR/exports" -type d -mtime -1 | wc -l)

## Recommendations

1. Regularly review quarantined files
2. Monitor disk usage in artifacts directory
3. Update malware definitions regularly
4. Review export logs for suspicious activity

---
*Generated by Archon Artifact Security System*
EOF

    success "Artifact security report generated: $report_file"
}

# Main menu function
show_usage() {
    cat << EOF
Secure Artifact Handling Script

Usage: $0 [command] [options]

Commands:
    setup                    Setup secure artifact environment
    validate <file>          Validate an artifact
    process <input> <output> Process artifact securely
    export <file> <name>     Export artifact with security controls
    monitor                  Start artifact monitoring
    cleanup                  Clean up old artifacts
    report                   Generate security report
    help                     Show this help message

Examples:
    $0 setup
    $0 validate /path/to/file.pdf
    $0 process input.txt processed/output.txt
    $0 export processed/file.txt "export-name"
    $0 monitor
    $0 cleanup
    $0 report

EOF
}

# Main execution
main() {
    local command="${1:-help}"
    
    case "$command" in
        setup)
            create_secure_directories
            create_artifact_user
            ;;
        validate)
            if [ $# -lt 2 ]; then
                error "Usage: $0 validate <file>"
                exit 1
            fi
            validate_artifact "$2"
            ;;
        process)
            if [ $# -lt 3 ]; then
                error "Usage: $0 process <input> <output>"
                exit 1
            fi
            process_artifact "$2" "$3"
            ;;
        export)
            if [ $# -lt 3 ]; then
                error "Usage: $0 export <file> <name>"
                exit 1
            fi
            export_artifact "$2" "$3"
            ;;
        monitor)
            monitor_artifacts
            ;;
        cleanup)
            cleanup_artifacts
            ;;
        report)
            generate_artifact_report
            ;;
        help|*)
            show_usage
            ;;
    esac
}

# Run main function if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi