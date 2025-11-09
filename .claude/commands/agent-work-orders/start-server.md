# Start Servers

Start both the FastAPI backend and React frontend development servers with hot reload.

## Run

### Run in the background with bash tool

- Ensure you are in the right PWD
- Use the Bash tool to run the servers in the background so you can read the shell outputs
- IMPORTANT: run `git ls-files` first so you know where directories are located before you start

### Backend Server (FastAPI)

- Navigate to backend: `cd app/backend`
- Start server in background: `uv sync && uv run python run_api.py`
- Wait 2-3 seconds for startup
- Test health endpoint: `curl http://localhost:8000/health`
- Test products endpoint: `curl http://localhost:8000/api/products`

### Frontend Server (Bun + React)

- Navigate to frontend: `cd ../app/frontend`
- Start server in background: `bun install && bun dev`
- Wait 2-3 seconds for startup
- Frontend should be accessible at `http://localhost:3000`

## Report

- Confirm backend is running on `http://localhost:8000`
- Confirm frontend is running on `http://localhost:3000`
- Show the health check response from backend
- Mention: "Backend logs will show structured JSON logging for all requests"
