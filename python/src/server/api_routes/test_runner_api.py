"""
Test Runner API endpoints

Provides endpoints to collect, run, and stream test results via SSE.
"""

import asyncio
import os
import re
import time
import uuid
from typing import Any

_APP_DIR = os.getenv("APP_DIR", "/app")

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..config.logfire_config import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/test-runner", tags=["test-runner"])

# In-memory store: run_id -> {"process": asyncio.Process, "queue": asyncio.Queue}
_runs: dict[str, dict[str, Any]] = {}

SUITES = {
    "mcp_server": ["tests/mcp_server"],
    "embedding": [
        "tests/test_async_embedding_service.py",
        "tests/test_embedding_service_no_zeros.py",
    ],
    "rag": [
        "tests/test_rag_simple.py",
        "tests/test_rag_strategies.py",
    ],
    "all": ["tests/"],
}

# Matches: tests/mcp_server/features/rag/test_rag_tools.py::test_name PASSED [ 0%]
_RESULT_RE = re.compile(
    r"^(tests/\S+)::(\w+(?:\[.*?\])?)\s+(PASSED|FAILED|SKIPPED|ERROR)"
)


class RunRequest(BaseModel):
    suite: str = "mcp_server"


@router.get("/collect")
async def collect_tests(suite: str = "mcp_server"):
    """Run pytest --collect-only and return list of test IDs."""
    paths = SUITES.get(suite, SUITES["mcp_server"])
    cmd = ["python3", "-m", "pytest"] + paths + ["--collect-only", "-q", "--no-header", "--tb=no"]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=_APP_DIR,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
        lines = stdout.decode().splitlines()

        tests = []
        for line in lines:
            line = line.strip()
            if "::" in line and not line.startswith("=") and not line.startswith("<"):
                parts = line.split("::")
                if len(parts) >= 2:
                    path = parts[0]
                    name = parts[-1].split(" ")[0]
                    tests.append({"id": f"{path}::{name}", "name": name, "path": path})

        return {"suite": suite, "tests": tests, "count": len(tests)}

    except Exception as e:
        logger.error(f"Failed to collect tests: {e}")
        return {"suite": suite, "tests": [], "count": 0, "error": str(e)}


@router.post("/run")
async def start_run(request: RunRequest):
    """Start a pytest subprocess and return a run_id for SSE streaming."""
    suite = request.suite
    paths = SUITES.get(suite, SUITES["mcp_server"])
    run_id = str(uuid.uuid4())

    queue: asyncio.Queue = asyncio.Queue()

    async def _run_pytest():
        cmd = (
            ["python3", "-m", "pytest"]
            + paths
            + ["-v", "--tb=no", "--no-header", "-p", "no:cacheprovider"]
        )
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=_APP_DIR,
            )
            _runs[run_id]["process"] = proc

            passed = failed = skipped = 0
            start = time.time()

            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode().rstrip()
                m = _RESULT_RE.match(text)
                if m:
                    path, name, status = m.group(1), m.group(2), m.group(3)
                    status_lower = status.lower()
                    if status_lower == "passed":
                        passed += 1
                    elif status_lower == "failed":
                        failed += 1
                    elif status_lower in ("skipped", "error"):
                        skipped += 1
                    await queue.put({
                        "type": "test_result",
                        "id": f"{path}::{name}",
                        "name": name,
                        "path": path,
                        "status": status_lower,
                    })

            await proc.wait()
            total = passed + failed + skipped
            await queue.put({
                "type": "summary",
                "passed": passed,
                "failed": failed,
                "skipped": skipped,
                "total": total,
                "duration": round(time.time() - start, 2),
            })

        except Exception as e:
            logger.error(f"Test run {run_id} failed: {e}")
            await queue.put({"type": "error", "message": str(e)})
        finally:
            await queue.put(None)  # Sentinel

    _runs[run_id] = {"process": None, "queue": queue}
    asyncio.create_task(_run_pytest())

    return {"run_id": run_id}


@router.get("/stream/{run_id}")
async def stream_run(run_id: str):
    """SSE endpoint — streams test_result and summary events for a run."""
    if run_id not in _runs:
        return StreamingResponse(
            _error_stream("Run not found"),
            media_type="text/event-stream",
        )

    queue = _runs[run_id]["queue"]

    async def _generate():
        try:
            while True:
                event = await asyncio.wait_for(queue.get(), timeout=300)
                if event is None:
                    break
                import json
                yield f"data: {json.dumps(event)}\n\n"
        except asyncio.TimeoutError:
            import json
            yield f"data: {json.dumps({'type': 'error', 'message': 'Stream timeout'})}\n\n"
        finally:
            _runs.pop(run_id, None)

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


async def _error_stream(message: str):
    import json
    yield f"data: {json.dumps({'type': 'error', 'message': message})}\n\n"
