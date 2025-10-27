---
name: archon-onboarding
description: |
  Onboard new developers to the Archon codebase with a comprehensive overview and first contribution guidance.

  Usage: /archon-onboarding
argument-hint: none
---

You are helping a new developer get up and running with the Archon V2 Beta project! Your goal is to provide them with a personalized onboarding experience.

## What is Archon?

Archon is a centralized knowledge base for AI coding assistants. It enables Claude Code, Cursor, Windsurf, and other AI tools to access your documentation, perform smart searches, and manage tasks - all through a unified interface.

Its powered by a **Model Context Protocol (MCP) server**

And you can crawl and store knowledge that you can use multiple rag strategies to improve your AI coders performance.

## Quick Architecture Overview

This is a **true microservices architecture** with 4 independent services:

1. **Frontend** (port 3737) - React UI for managing knowledge and projects
2. **Server** (port 8181) - Core API handling all business logic
3. **MCP Server** (port 8051) - Lightweight MCP protocol interface
4. **Agents** (port 8052) - AI operations with PydanticAI

All services communicate via HTTP only - no shared code, true separation of concerns.

## Getting Started - Your First 30 Minutes

### Prerequisites Check

You'll need:

- Docker Desktop (running)
- Supabase account (free tier works)
- OpenAI API key (or Gemini/Ollama)
- Git and basic command line knowledge

### Setup

First, read the README.md file to understand the setup process, then guide the user through these steps:

1. Clone the repository and set up environment variables
2. Configure Supabase database with migration scripts
3. Start Docker services
4. Configure API keys in the UI
5. Verify everything is working by testing a simple crawl

## Understanding the Codebase

### Decision Time

Ask the user to choose their focus area. Present these options clearly and wait for their response:

"Which area of the Archon codebase would you like to explore first?"

1. **Frontend (React/TypeScript)** - If you enjoy UI/UX work
2. **Backend API (Python/FastAPI)** - If you like building robust APIs
3. **MCP Tools (Python)** - If you're interested in AI tool protocols
4. **RAG/Search (Python)** - If you enjoy search and ML engineering
5. **Web Crawling (Python)** - If you like data extraction challenges

### Your Onboarding Analysis

Based on the user's choice, perform a deep analysis of that area following the instructions below for their specific choice. Then provide them with a structured report.

## Report Structure

Your report to the user should include:

1. **Area Overview**: Architecture explanation and how it connects to other services
2. **Key Files Walkthrough**: Purpose of main files and their relationships
3. **Suggested First Contribution**: A specific, small improvement with exact location
4. **Implementation Guide**: Step-by-step instructions to make the change
5. **Testing Instructions**: How to verify their change works correctly

**If the user chose Frontend:**

- Start with `archon-ui-main/src/pages/KnowledgeBasePage.tsx`
- Look at how it uses `services/knowledgeBaseService.ts`
- Take a deep dive into the frontend architecture and UI components
- Identify a potential issue that the user can easily fix and suggest a solution
- Give the user a overview of the frontend and architecture following the report format above

**If the user chose Backend API:**

- Start with `python/src/server/api_routes/knowledge_api.py`
- See how it calls `services/knowledge/knowledge_item_service.py`
- Take a deep dive into the FastAPI service architecture and patterns
- Identify a potential API improvement that the user can implement
- Give the user an overview of the backend architecture and suggest a contribution

**If the user chose MCP Tools:**

- Start with `python/src/mcp/mcp_server.py`
- Look at `modules/rag_module.py` for tool patterns
- Take a deep dive into the MCP protocol implementation and available tools
- Identify a missing tool or enhancement that would be valuable
- Give the user an overview of the MCP architecture and how to add new tools

**If the user chose RAG/Search:**

- Start with `python/src/server/services/search/vector_search_service.py`
- Understand the hybrid search approach
- Take a deep dive into the RAG pipeline and search strategies
- Identify a search improvement or ranking enhancement opportunity
- Give the user an overview of the RAG system and suggest optimizations

**If the user chose Web Crawling:**

- Start with `python/src/server/services/rag/crawling_service.py`
- Look at sitemap detection and parsing logic
- Take a deep dive into the crawling architecture and content extraction
- Identify a crawling enhancement or new content type support to add
- Give the user an overview of the crawling system and parsing strategies

## How to Find Contribution Opportunities

When analyzing the user's chosen area, look for:

- TODO or FIXME comments in the code
- Missing error handling or validation
- UI components that could be more user-friendly
- API endpoints missing useful filters or data
- Areas with minimal or no test coverage
- Hardcoded values that should be configurable

## What to Include in Your Report

After analyzing their chosen area, provide the user with:

1. Key development patterns they should know:
   - Beta mindset (break things to improve them)
   - Error philosophy (fail fast with detailed errors)
   - Service boundaries (no cross-service imports)
   - Real-time updates via Socket.IO
   - Testing approach for their chosen area

2. Specific contribution suggestion with:
   - Exact file and line numbers to modify
   - Current behavior vs improved behavior
   - Step-by-step implementation guide
   - Testing instructions

3. Common gotchas for their area:
   - Service-specific pitfalls
   - Testing requirements
   - Local vs Docker differences

Remember to encourage the user to start small and iterate. This is beta software designed for rapid experimentation.
