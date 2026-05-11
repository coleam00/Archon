---
description: "Install dependencies and run both server and client"
agent: "agent"
tools:
  - runInTerminal
  - readFile
---

# Install

## Run

Think through each step carefully to ensure nothing is missed.

### Server

1. Navigate to server: `cd server`
2. Install dependencies: `pnpm install`
3. Start API server (in background): `pnpm dev &`
4. Wait for server to start: `sleep 3`
5. Verify API is running: `curl http://localhost:3001/api/flags`

### Client

1. Navigate to client: `cd client`
2. Install dependencies: `pnpm install`
3. Start dev server (in background): `pnpm dev &`
4. Verify client is running at http://localhost:3000

## Report

Output what you've done in a concise bullet point list:
- Server: http://localhost:3001, API response
- Client: http://localhost:3000
- Any issues encountered
