---
description: Generate Root Cause Analysis report for Archon V2 Beta issues
argument-hint: <issue description or error message>
allowed-tools: Bash(*), Read, Grep, LS, Write
thinking: auto
---

# Root Cause Analysis for Archon V2 Beta

**Issue to investigate**: $ARGUMENTS

investigate this issue systematically and generate an RCA report saved to `RCA.md` in the project root.

## Context About Archon

You're working with Archon V2 Beta, a microservices-based AI knowledge management system:

- **Frontend**: React + TypeScript on port 3737
- **Main Server**: FastAPI + Socket.IO on port 8181
- **MCP Server**: Lightweight HTTP protocol server on port 8051
- **Agents Service**: PydanticAI agents on port 8052
- **Database**: Supabase (PostgreSQL + pgvector)

All services run in Docker containers managed by docker-compose.

## Investigation Approach

### 1. Initial Assessment

First, understand what's broken:

- What exactly is the symptom?
- Which service(s) are affected?
- When did it start happening?
- Is it reproducible?

### 2. System Health Check

Check if all services are running properly:

- Docker container status (`docker-compose ps`)
- Service health endpoints (ports 8181, 8051, 8052, 3737)
- Recent error logs from affected services
- Database connectivity

### 3. Error Handling Analysis

**Remember: In Beta, we want DETAILED ERRORS that help us fix issues fast!**

Look for these error patterns:

**Good errors (what we want):**

- Stack traces with full context
- Specific error messages saying what failed
- Service initialization failures that stop the system
- Validation errors that show what was invalid

**Bad patterns (what causes problems):**

- Silent failures returning None/null
- Generic "Something went wrong" messages
- Catch-all exception handlers hiding the real issue
- Services continuing with broken dependencies

### 4. Targeted Investigation

Based on the issue type, investigate specific areas:

**For API/Backend issues**: Check FastAPI routes, service layer, database queries
**For Frontend issues**: Check React components, API calls, build process
**For MCP issues**: Check tool definitions, session management, HTTP calls
**For Real-time issues**: Check Socket.IO connections, event handling
**For Database issues**: Check Supabase connection, migrations, RLS policies

### 5. Root Cause Identification

- Follow error stack traces to the source
- Check if errors are being swallowed somewhere
- Look for missing error handling where it should fail fast
- Check recent code changes (`git log`)
- Identify any dependency or initialization order problems

### 6. Impact Analysis

Determine the scope:

- Which features are affected?
- Is this a startup failure or runtime issue?
- Is there data loss or corruption?
- Are errors propagating correctly or being hidden?

## Key Places to Look

Think hard about where to look, there is some guidance below that you can follow

**Configuration files:**

- `.env` - Environment variables
- `docker-compose.yml` - Service configuration
- `python/src/server/config.py` - Server settings

**Service entry points:**

- `python/src/server/main.py` - Main server
- `python/src/mcp/server.py` - MCP server
- `archon-ui-main/src/main.tsx` - Frontend

**Common problem areas:**

- `python/src/server/services/credentials_service.py` - Must initialize first
- `python/src/server/services/supabase_service.py` - Database connections
- `python/src/server/socketio_manager.py` - Real-time events
- `archon-ui-main/src/services/` - Frontend API calls

## Report Structure

Generate an RCA.md report with:

```markdown
# Root Cause Analysis

**Date**: [Today's date]
**Issue**: [Brief description]
**Severity**: [Critical/High/Medium/Low]

## Summary

[One paragraph overview of the issue and its root cause]

## Investigation

### Symptoms

- [What was observed]

### Diagnostics Performed

- [Health checks run]
- [Logs examined]
- [Code reviewed]

### Root Cause

[Detailed explanation of why this happened]

## Impact

- **Services Affected**: [List]
- **User Impact**: [Description]
- **Duration**: [Time period]

## Resolution

### Immediate Fix

[What needs to be done right now]

### Long-term Prevention

[How to prevent this in the future]

## Evidence

[Key logs, error messages, or code snippets that led to the diagnosis]

## Lessons Learned

[What we learned from this incident]
```

## Helpful Commands

```bash
# Check all services
docker-compose ps

# View recent errors
docker-compose logs --tail=50 [service-name] | grep -E "ERROR|Exception"

# Health checks
curl http://localhost:8181/health
curl http://localhost:8051/health

# Database test
docker-compose exec archon-server python -c "from src.server.services.supabase_service import SupabaseService; print(SupabaseService.health_check())"

# Resource usage
docker stats --no-stream
```

Remember: Focus on understanding the root cause, not just symptoms. The goal is to create a clear, actionable report that helps prevent similar issues in the future.
