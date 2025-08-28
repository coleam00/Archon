# Docker Security Policy and Best Practices

## Overview

This document outlines the comprehensive security measures implemented for the Archon project's Docker containers, including test runners and production services.

## Security Principles

### 1. Principle of Least Privilege
- All containers run as non-root users (UID/GID 1001)
- Minimal Linux capabilities granted per container
- Read-only root filesystems where possible
- Restricted access to host resources

### 2. Defense in Depth
- Multiple layers of security controls
- Input validation and sanitization
- Network segmentation
- Monitoring and alerting

### 3. Secure by Default
- Security-first configuration
- Automatic security updates
- Fail-safe error handling
- Comprehensive logging

## Container Security Implementation

### Non-Root User Configuration

All containers implement secure non-root user execution:

```dockerfile
# Create non-root user for security
RUN addgroup -g 1001 -S appuser && \
    adduser -S -D -H -u 1001 -s /sbin/nologin -G appuser appuser

# Switch to non-root user
USER appuser

# Use gosu for privilege dropping in entrypoints
ENTRYPOINT ["dumb-init", "--"]
CMD ["gosu", "appuser", "command"]
```

### Permission Management

#### File System Permissions
- Application directories: `755` (owner: appuser:appuser)
- Configuration files: `644` (owner: appuser:appuser)
- Executable scripts: `755` (owner: appuser:appuser)
- Temporary directories: `700` (owner: appuser:appuser)

#### Volume Mount Security
```yaml
volumes:
  # Read-only mounts for source code
  - ./src:/app/src:ro
  # Read-only mounts for configuration
  - ./config:/app/config:ro
  # Writable mounts only where necessary
  - ./data:/app/data:rw
```

### Container Runtime Security

#### Security Options
```yaml
security_opt:
  - no-new-privileges:true  # Prevent privilege escalation

# Read-only root filesystem
read_only: true

# Temporary filesystems for write access
tmpfs:
  - /tmp:rw,noexec,nosuid,size=100m
  - /var/tmp:rw,noexec,nosuid,size=50m

# Capability dropping
cap_drop:
  - ALL
cap_add:
  - SETGID          # Required for user switching
  - SETUID          # Required for user switching  
  - NET_BIND_SERVICE # Required for binding to ports
```

### Image Security

#### Base Image Selection
- Use official, minimal base images (alpine, slim)
- Regularly updated base images
- Vulnerability-free base images

#### Build Security
```dockerfile
# Install security updates
RUN apk upgrade --no-cache

# Remove unnecessary packages
RUN apk del build-dependencies

# Clean package caches
RUN rm -rf /var/cache/apk/* /tmp/* /var/tmp/*

# Remove potential security risks
RUN find /app -name "*.pyc" -delete
RUN find /app -name "__pycache__" -type d -exec rm -rf {} +
```

## Service-Specific Security

### Frontend Service (archon-frontend)
- Runs as user `appuser` (1001:1001)
- Read-only source and public mounts
- Node.js security best practices
- CSP headers and XSS protection

### Backend Services (server, mcp, agents)
- Isolated non-root users per service
- Minimal Python dependencies
- Secure secret management
- Database connection encryption

### Test Runners
- Sandboxed test execution
- Isolated test data
- Secure artifact handling
- Result validation

## Network Security

### Container Networking
```yaml
networks:
  app-network:
    driver: bridge
    ipam:
      driver: default
      config:
        - subnet: 172.20.0.0/16
```

### Port Exposure
- Only necessary ports exposed
- No privileged ports (<1024) without proper capability
- Internal service communication via container names

### Service Discovery
- DNS-based service discovery
- No hardcoded IP addresses
- Encrypted inter-service communication

## Secret Management

### Environment Variables
```yaml
environment:
  # Secrets from environment or Docker secrets
  - SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
  - OPENAI_API_KEY=${OPENAI_API_KEY}
  # Non-sensitive configuration
  - NODE_ENV=production
  - LOG_LEVEL=INFO
```

### Docker Secrets (Production)
```yaml
secrets:
  supabase_key:
    external: true
  openai_key:
    external: true

services:
  archon-server:
    secrets:
      - supabase_key
      - openai_key
```

## Monitoring and Alerting

### Health Checks
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8181/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 40s
```

### Security Monitoring
- Container runtime monitoring
- File integrity monitoring
- Process monitoring
- Network traffic analysis

### Log Management
```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

## Vulnerability Management

### Regular Scanning
- Daily base image scans
- Build-time vulnerability scanning
- Runtime container scanning
- Dependency vulnerability tracking

### Scanning Tools
1. **Trivy** - Container vulnerability scanning
2. **Hadolint** - Dockerfile security linting
3. **Docker Bench Security** - CIS benchmark compliance
4. **Snyk** - Dependency vulnerability scanning

### Update Process
1. Monitor security advisories
2. Test updates in staging environment
3. Deploy updates with rollback capability
4. Verify security posture post-deployment

## Incident Response

### Security Events
- Privilege escalation attempts
- Suspicious file system access
- Unexpected network connections
- Container breakout attempts

### Response Procedures
1. **Detection** - Automated monitoring alerts
2. **Analysis** - Security team investigation
3. **Containment** - Isolate affected containers
4. **Eradication** - Remove threats and vulnerabilities
5. **Recovery** - Restore services safely
6. **Lessons Learned** - Update security measures

## Compliance and Auditing

### Security Standards
- CIS Docker Benchmark
- NIST Cybersecurity Framework
- OWASP Container Security
- Docker Security Best Practices

### Audit Trail
- All security events logged
- Configuration changes tracked
- Access patterns monitored
- Compliance reports generated

### Regular Assessments
- Monthly security reviews
- Quarterly penetration testing
- Annual security audits
- Continuous compliance monitoring

## Implementation Checklist

### Container Security
- [x] Non-root user implementation
- [x] Capability dropping (ALL)
- [x] Read-only root filesystem (where possible)
- [x] Security options configured
- [x] Temporary filesystem mounts
- [x] Health checks implemented

### Image Security
- [x] Minimal base images
- [x] Security updates applied
- [x] Build dependencies removed
- [x] Cache cleaning implemented
- [x] Metadata removal
- [x] Vulnerability scanning

### Network Security
- [x] Isolated container network
- [x] Minimal port exposure
- [x] Service-to-service encryption
- [x] Network policies defined

### Monitoring
- [x] Security monitoring configured
- [x] Log aggregation setup
- [x] Alerting rules defined
- [x] Dashboard created

### Documentation
- [x] Security policies documented
- [x] Incident response procedures
- [x] Compliance requirements mapped
- [x] Training materials created

## Security Tools and Scripts

### Security Scanning
- `scripts/security-scan.sh` - Comprehensive security scanner
- `security/docker-security.yml` - Security configuration
- `security/artifact-security.sh` - Secure artifact handling

### Monitoring Scripts
- Container runtime monitoring
- Security event detection
- Compliance reporting
- Vulnerability tracking

## Maintenance and Updates

### Regular Tasks
- Weekly vulnerability scans
- Monthly security configuration reviews
- Quarterly security assessments
- Annual policy updates

### Update Schedule
- Base images: Weekly
- Security patches: As available
- Configuration updates: Monthly
- Policy reviews: Quarterly

## Contact Information

### Security Team
- Email: security@archon-project.com
- Slack: #security-alerts
- Phone: Emergency hotline

### Escalation Procedures
1. **Level 1**: Development team
2. **Level 2**: Security team
3. **Level 3**: Management team
4. **Level 4**: External security experts

---

**Document Version**: 1.0  
**Last Updated**: $(date)  
**Next Review**: $(date -d "+3 months")  
**Owner**: Archon Security Team