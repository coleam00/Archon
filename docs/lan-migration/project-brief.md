# Project Brief
## Archon Knowledge Base: Local-to-LAN Server Migration

**Project Code:** ARCHON-LAN-001  
**Date:** September 2025  
**Duration:** 7 Days  
**Priority:** Medium-High

---

## Executive Summary

Transform Archon from a single-machine installation to a centralized LAN-accessible knowledge management system by leveraging existing Traefik proxy infrastructure. This migration enables multi-device access while maintaining the current zero-authentication simplicity for trusted local network users.

---

## Business Context

### Current State
- **Single-user limitation:** Archon runs locally on individual machines
- **Access restriction:** Only accessible from host machine (localhost)
- **Redundant installations:** Each user needs separate setup
- **Maintenance overhead:** Multiple instances to update

### Desired Future State
- **Centralized deployment:** Single server installation
- **Network accessibility:** Access from any LAN device
- **Unified instance:** One system for all users
- **Move off Local Machine:** To free up local resources
- **Simplified maintenance:** Single point of update

### Strategic Alignment
This migration supports the homelab's evolution toward centralized services while maintaining security through network isolation and leveraging existing infrastructure investments (Traefik/Let's Encrypt).

---

## Project Objectives

### Primary Objectives
1. ✅ Enable multi-device access within local network
2. ✅ Integrate with existing Traefik proxy (*.mcdonaldhomelab.com)
3. ✅ Maintain zero-authentication for LAN users
4. ✅ Preserve all current Archon functionality

### Secondary Objectives
- Improve performance through centralized resources
- Enable SSL/TLS encryption via Let's Encrypt
- Simplify backup and maintenance procedures
- Prepare foundation for future enhancements

---

## Scope

### In Scope
- Docker container migration to server
- Traefik reverse proxy integration
- Network configuration for LAN access
- SSL certificate automation
- Service health monitoring
- Basic documentation

### Out of Scope
- User authentication system
- External internet access
- Database migration (uses existing internal Supabase)
- Kubernetes orchestration
- Multi-tenancy features
- Advanced monitoring stack

---

## Key Stakeholders

| Role | Responsibility | Involvement |
|------|---------------|-------------|
| **System Owner** | Final decisions, server access | High |
| **End Users** | Testing, feedback | Medium |
| **Network Admin** | DNS, firewall configuration | Medium |
| **DevOps Lead** | Implementation, deployment | High |

---

## Technical Overview

### Architecture Transition

**From:** `localhost:3737` → Local Docker  
**To:** `https://archon.mcdonaldhomelab.com` → Server Docker + Traefik

### Technology Stack
- **Existing Infrastructure:** Traefik proxy with Let's Encrypt
- **Containers:** archon-frontend, archon-server, archon-mcp
- **Networks:** External 'proxy' + Internal 'archon-internal'
- **Database:** Internal Supabase (supabase.mcdonaldhomelab.com)

### Key Technical Changes
1. **Unified deployment**: Single docker-compose.yml with environment variables
2. **Mode switching**: `DEPLOYMENT_MODE` variable controls local/LAN behavior
3. **Conditional Traefik**: Labels activate only when `ENABLE_TRAEFIK=true`
4. **Instant rollback**: Switch modes in seconds via environment files
5. **No code changes**: All configuration through .env.local and .env.lan

---

## Benefits & Value Proposition

### Immediate Benefits
- **Accessibility:** Use from laptop, desktop, tablet on LAN
- **Security:** HTTPS encryption with valid certificates (LAN mode)
- **Simplicity:** Single URL, no port numbers
- **Reliability:** Auto-restart, health monitoring
- **Flexibility:** Instant switch between local and LAN modes
- **Zero downtime:** Rollback in seconds if issues arise

### Long-term Value
- **Scalability:** Foundation for growth
- **Maintainability:** Centralized updates
- **Integration:** MCP tools from any workstation
- **Cost Efficiency:** Single instance vs. multiple

### Risk Reduction
- ✅ Eliminates CORS complexity
- ✅ Automates SSL management
- ✅ Provides fallback to local if needed
- ✅ Uses proven Traefik infrastructure

---

## Timeline & Milestones

| Phase | Duration | Deliverables | Milestone |
|-------|----------|--------------|-----------|
| **Planning** | Day 1 | Requirements validated, .env templates created | Ready to Build |
| **Configuration** | Day 2-3 | Docker compose modified, deploy script created | Ready to Deploy |
| **Deployment** | Day 4-5 | Test both modes, verify instant switching | System Live |
| **Validation** | Day 6 | Multi-device testing, rollback verification | User Acceptance |
| **Documentation** | Day 7 | Guides updated, mode switching documented | Project Complete |

---

## Resource Requirements

### Infrastructure
- **Server:** 4GB RAM, 2 CPU cores, 20GB storage
- **Network:** Existing LAN with Traefik proxy
- **Domain:** archon.mcdonaldhomelab.com (available)

### Human Resources
- **Implementation:** 1 DevOps engineer (8-10 hours)
- **Testing:** 2-3 end users (2 hours each)
- **Documentation:** 1 technical writer (2 hours)

### Budget Estimate
- **Infrastructure:** $0 (using existing server)
- **Software:** $0 (open source stack)
- **Time Investment:** ~16 person-hours
- **Total Cost:** Labor only

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|---------|------------|
| Network latency | Low | Medium | Caching, optimization |
| Configuration error | Medium | High | Staging tests, rollback plan |
| User adoption | Low | Low | Training, documentation |
| Resource constraints | Low | Medium | Monitor, scale as needed |

**Overall Risk Level:** **Low-Medium** (Due to existing Traefik infrastructure)

---

## Success Criteria

### Technical Success
- ☐ All services accessible via HTTPS
- ☐ Response time <200ms
- ☐ 99% uptime achieved
- ☐ Auto-recovery functional

### User Success
- ☐ Access from 3+ devices verified
- ☐ All features working as expected
- ☐ No authentication required on LAN
- ☐ Positive user feedback

### Operational Success
- ☐ Single command deployment
- ☐ Automated certificate renewal
- ☐ Monitoring in place
- ☐ Documentation complete

---

## Decision Points

### Immediate Decisions Required
1. **Subdomain strategy:** Single domain with paths vs. multiple subdomains
2. **Docker socket:** Keep for MCP control or remove for security
3. **Resource limits:** Specific CPU/memory constraints
4. **Backup strategy:** Frequency and retention policy

### Future Considerations
- Authentication implementation timeline
- External access requirements
- Scaling strategy if user base grows
- Integration with other homelab services

---

## Next Steps

1. **Approve project brief** (Day 0)
2. **Verify prerequisites** (Day 1)
   - Traefik operational
   - Server resources available
   - DNS control confirmed
3. **Begin implementation** (Day 2)
4. **Schedule user testing** (Day 6)
5. **Plan go-live** (Day 7)

---

## Project Approval

**Recommended Action:** Proceed with implementation

**Justification:** 
- Low risk due to existing infrastructure
- High value for minimal investment
- Clear technical path with fallback options
- Enables future growth and enhancement

---

**Sign-off Required:**

| Approver | Role | Date | Decision |
|----------|------|------|----------|
| | System Owner | | ☐ Approved / ☐ Rejected |
| | Technical Lead | | ☐ Approved / ☐ Rejected |

---

*Document created: January 2025*  
*Author: Mary, Business Analyst*  
*Version: 1.0*