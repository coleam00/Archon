---
name: prime-simple
description: Quick context priming for Archon development - reads essential files and provides project overview
argument-hint: none
---

## Prime Context for Archon Development

You need to quickly understand the Archon V2 Beta codebase. Follow these steps:

### 1. Read Project Documentation

- Read `CLAUDE.md` for development guidelines and patterns
- Read `README.md` for project overview and setup

### 2. Understand Project Structure

Use `tree -L 2` or explore the directory structure to understand the layout:

- `archon-ui-main/` - Frontend React application
- `python/` - Backend services (server, MCP, agents)
- `docker-compose.yml` - Service orchestration
- `migration/` - Database setup scripts

### 3. Read Key Frontend Files

Read these essential files in `archon-ui-main/`:

- `src/App.tsx` - Main application entry and routing
- Make your own decision of how deep to go into other files

### 4. Read Key Backend Files

Read these essential files in `python/`:

- `src/server/main.py` - FastAPI application setup
- Make your own decision of how deep to go into other files

### 5. Review Configuration

- `.env.example` - Required environment variables
- `docker-compose.yml` - Service definitions and ports
- Make your own decision of how deep to go into other files

### 6. Provide Summary

After reading these files, explain to the user:

1. **Project Purpose**: One sentence about what Archon does and why it exists
2. **Architecture**: One sentence about the architecture
3. **Key Patterns**: One sentence about key patterns
4. **Tech Stack**: One sentence about tech stack

Remember: This is beta software focused on rapid iteration. Prioritize understanding the core functionality
