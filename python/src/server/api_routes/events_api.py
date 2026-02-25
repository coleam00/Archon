"""
System Events API — SSE bridge from Redis pub/sub to the browser.

Streams all Archon event channels so frontends can show real-time
notifications without polling:
- events:task     — Task lifecycle events
- events:session  — Session lifecycle events
- events:work_order — Work order events
- events:error    — Error/warning events for monitoring
"""

import asyncio
import json
from collections.abc import AsyncIterator

import redis.asyncio as redis
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from ..config.logfire_config import get_logger
from ..config.redis_config import REDIS_URL

logger = get_logger(__name__)

router = APIRouter(prefix="/api/events", tags=["events"])

_CHANNELS = ["events:task", "events:session", "events:work_order", "events:error"]
_KEEPALIVE_INTERVAL = 30  # seconds


@router.get("/stream")
async def stream_events() -> StreamingResponse:
    """SSE stream — bridges all Redis event channels to connected browsers."""
    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


async def _generate() -> AsyncIterator[str]:
    """Async generator that subscribes to Redis and yields SSE-formatted events."""
    redis_url = REDIS_URL
    r: redis.Redis | None = None
    pubsub: redis.client.PubSub | None = None
    listener_task: asyncio.Task | None = None
    keepalive_task: asyncio.Task | None = None

    try:
        r = await redis.from_url(redis_url, encoding="utf-8", decode_responses=True)
        pubsub = r.pubsub()
        await pubsub.subscribe(*_CHANNELS)
        logger.info(f"SSE client connected, subscribed to channels: {_CHANNELS}")

        queue: asyncio.Queue[tuple[str, str | None, str | None]] = asyncio.Queue()

        async def _redis_listener() -> None:
            try:
                async for message in pubsub.listen():
                    if message["type"] == "message":
                        await queue.put(("event", message["channel"], message["data"]))
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                await queue.put(("error", None, str(exc)))
            finally:
                await queue.put(("close", None, None))

        async def _keepalive_sender() -> None:
            try:
                while True:
                    await asyncio.sleep(_KEEPALIVE_INTERVAL)
                    await queue.put(("keepalive", None, None))
            except asyncio.CancelledError:
                pass

        listener_task = asyncio.create_task(_redis_listener())
        keepalive_task = asyncio.create_task(_keepalive_sender())

        while True:
            kind, channel, data = await queue.get()
            if kind == "close":
                break
            if kind == "keepalive":
                yield ": keepalive\n\n"
            elif kind == "event":
                try:
                    payload = json.loads(data)
                    payload["_channel"] = channel
                    yield f"data: {json.dumps(payload)}\n\n"
                except json.JSONDecodeError:
                    pass
            elif kind == "error":
                yield f"data: {json.dumps({'type': 'stream_error', 'message': data})}\n\n"
                break

    except (asyncio.CancelledError, GeneratorExit):
        logger.info("SSE client disconnected")
    except Exception as exc:
        logger.error(f"SSE stream error: {exc}")
        try:
            yield f"data: {json.dumps({'type': 'stream_error', 'message': str(exc)})}\n\n"
        except GeneratorExit:
            pass
    finally:
        for task in [listener_task, keepalive_task]:
            if task:
                task.cancel()
        await asyncio.gather(
            *[t for t in [listener_task, keepalive_task] if t],
            return_exceptions=True,
        )
        if pubsub:
            try:
                await pubsub.unsubscribe(*_CHANNELS)
                await pubsub.aclose()
            except Exception:
                pass
        if r:
            try:
                await r.aclose()
            except Exception:
                pass
        logger.info("SSE stream closed")
