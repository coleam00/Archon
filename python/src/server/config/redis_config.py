"""Redis configuration — single source of truth for the Redis connection URL."""

import os

REDIS_URL: str = os.getenv("REDIS_URL", "redis://localhost:6379")
