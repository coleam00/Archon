"""
Socket.IO Server Integration for Archon

Simple Socket.IO server setup with FastAPI integration.
All events are handled in projects_api.py using @sio.event decorators.
"""

import logging

import socketio
from fastapi import FastAPI

from .config.logfire_config import safe_logfire_info

logger = logging.getLogger(__name__)

# Create Socket.IO server with FastAPI integration
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",  # TODO: Configure for production with specific origins
    logger=False,  # Disable verbose Socket.IO logging
    engineio_logger=False,  # Disable verbose Engine.IO logging
    # Performance settings for long-running operations
    max_http_buffer_size=1000000,  # 1MB
    ping_timeout=300,  # 5 minutes - increased for background tasks
    ping_interval=60,  # 1 minute - check connection every minute
)


def create_socketio_app(app: FastAPI) -> socketio.ASGIApp:
    """
    Wrap FastAPI app with Socket.IO ASGI app.

    Args:
        app: FastAPI application instance

    Returns:
        Socket.IO ASGI app that wraps the FastAPI app
    """
    # Log Socket.IO server creation
    safe_logfire_info(
        "Creating Socket.IO server", cors_origins="*", ping_timeout=300, ping_interval=60
    )

    # Note: Socket.IO event handlers are registered in socketio_handlers.py
    # This module only creates the Socket.IO server instance

    # Create and return the Socket.IO ASGI app
    socket_app = socketio.ASGIApp(sio, other_asgi_app=app)

    # Store the app reference for later use
    sio.app = app

    return socket_app
    
# Default Socket.IO event handlers
@sio.event
async def connect(sid, environ):
    """Handle new client connections."""
    logger.info(f"Client connected: {sid}")
    safe_logfire_info(f"Client connected: {sid}")


@sio.event
async def disconnect(sid):
    """Handle client disconnections."""
    logger.info(f"Client disconnected: {sid}")
    safe_logfire_info(f"Client disconnected: {sid}")


@sio.event
async def message(sid, data):
    """Handle incoming messages."""
    logger.info(f"Received message from {sid}: {data}")
    await sio.emit("response", {"data": "Message received!"}, to=sid)