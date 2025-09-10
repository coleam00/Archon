"""
Logging Middleware for FastAPI

Automatically logs requests and responses using logfire when available.
Follows 2025 best practices for simple, automatic instrumentation.
"""

import time
from collections.abc import Callable

from fastapi import Request, Response
from fastapi.routing import APIRoute
from starlette.middleware.base import BaseHTTPMiddleware

from ..config.logfire_config import LOGFIRE_AVAILABLE, get_logger, is_logfire_enabled


class LoggingMiddleware(BaseHTTPMiddleware):
    """
    Middleware that automatically logs HTTP requests and responses.

    Skips health check endpoints to reduce noise.
    """

    SKIP_PATHS = {"/health", "/api/health", "/", "/docs", "/redoc", "/openapi.json"}

    def __init__(self, app):
        super().__init__(app)
        self.logger = get_logger("middleware")

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        # Skip logging for certain paths
        if request.url.path in self.SKIP_PATHS:
            return await call_next(request)

        # Record start time
        start_time = time.time()

        # Lightweight request/response size capture (header-based only)
        req_size = request.headers.get("content-length", "unknown")

        # Log the request
        self.logger.info(
            f"HTTP Request | method={request.method} | path={request.url.path} | client={request.client.host if request.client else 'unknown'} | req_bytes={req_size}"
        )

        try:
            # Process the request
            response = await call_next(request)

            # Calculate duration
            duration = time.time() - start_time

            # Response size (if available)
            resp_size = response.headers.get("content-length", "unknown")

            # Log the response
            self.logger.info(
                f"HTTP Response | method={request.method} | path={request.url.path} | status_code={response.status_code} | duration_ms={round(duration * 1000, 2)} | resp_bytes={resp_size}"
            )

            return response

        except Exception as e:
            # Log errors with stacktrace
            duration = time.time() - start_time
            self.logger.error(
                f"HTTP Error | method={request.method} | path={request.url.path} | error={str(e)} | duration_ms={round(duration * 1000, 2)}",
                exc_info=True,
            )
            raise


def instrument_fastapi(app):
    """
    Instrument a FastAPI app with automatic logging.

    This is the recommended approach for 2025 - let logfire handle the complexity.
    """
    logger = get_logger("instrumentation")

    if is_logfire_enabled() and LOGFIRE_AVAILABLE:
        try:
            # Import logfire for instrumentation only when enabled
            import logfire

            # Use logfire's built-in FastAPI instrumentation
            logfire.instrument_fastapi(app)
            logger.info("FastAPI instrumented with logfire")
        except Exception as e:
            logger.error(f"Failed to instrument FastAPI with logfire: {e}")
            # Fall back to our custom middleware
            app.add_middleware(LoggingMiddleware)
    else:
        # Use our custom middleware for basic logging
        app.add_middleware(LoggingMiddleware)
        logger.info("FastAPI instrumented with custom logging middleware")


class LoggingRoute(APIRoute):
    """
    Custom APIRoute that logs endpoint execution time.

    This provides more granular logging than middleware alone.
    """

    def get_route_handler(self) -> Callable:
        original_route_handler = super().get_route_handler()
        logger = get_logger("endpoint")

        async def custom_route_handler(request: Request) -> Response:
            start_time = time.time()

            # Get endpoint info
            endpoint_name = self.endpoint.__name__ if self.endpoint else "unknown"

            try:
                response = await original_route_handler(request)
                duration = time.time() - start_time

                # Log successful endpoint execution
                logger.info(
                    f"Endpoint: {endpoint_name} | duration_ms={round(duration * 1000, 2)} | status=success"
                )

                return response

            except Exception as e:
                duration = time.time() - start_time

                # Log endpoint error
                logger.error(
                    f"Endpoint: {endpoint_name} | duration_ms={round(duration * 1000, 2)} | status=error | error={str(e)}"
                )
                raise

        return custom_route_handler
