"""Agent Work Orders FastAPI Application

PRD-compliant agent work order system.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.routes import router
from .config import config
from .utils.structured_logger import configure_structured_logging

# Configure logging on startup
configure_structured_logging(config.LOG_LEVEL)

app = FastAPI(
    title="Agent Work Orders API",
    description="Agent work order system for workflow-based agent execution",
    version="0.1.0",
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routes
app.include_router(router)


@app.get("/health")
async def health() -> dict:
    """Health check endpoint"""
    return {
        "status": "healthy",
        "service": "agent-work-orders",
        "version": "0.1.0",
    }
