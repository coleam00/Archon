"""Agent Work Orders API Gateway Proxy

Proxies requests from the main API to the independent agent work orders service.
This provides a single API entry point for the frontend while maintaining service independence.
"""

import logging

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

from ..config.service_discovery import get_agent_work_orders_url

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/agent-work-orders", tags=["agent-work-orders"])


@router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    response_class=Response,
)
async def proxy_to_agent_work_orders(request: Request, path: str = "") -> Response:
    """Proxy all requests to the agent work orders microservice.

    This acts as an API gateway, forwarding requests to the independent
    agent work orders service while maintaining a single API entry point.

    Args:
        request: The incoming HTTP request
        path: The path segment to proxy (captured from URL)

    Returns:
        Response from the agent work orders service with preserved headers and status

    Raises:
        HTTPException: 503 if service unavailable, 504 if timeout, 500 for other errors
    """
    # Get service URL from service discovery (outside try block for error handlers)
    service_url = get_agent_work_orders_url()

    try:

        # Build target URL
        target_path = f"/api/agent-work-orders/{path}" if path else "/api/agent-work-orders/"
        target_url = f"{service_url}{target_path}"

        # Preserve query parameters
        query_string = str(request.url.query) if request.url.query else ""
        if query_string:
            target_url = f"{target_url}?{query_string}"

        # Read request body
        body = await request.body()

        # Prepare headers (exclude host and connection headers)
        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in ["host", "connection"]
        }

        logger.debug(
            f"Proxying {request.method} {request.url.path} to {target_url}",
            extra={
                "method": request.method,
                "source_path": request.url.path,
                "target_url": target_url,
                "query_params": query_string,
            },
        )

        # Forward request to agent work orders service
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.request(
                method=request.method,
                url=target_url,
                content=body if body else None,
                headers=headers,
            )

        logger.debug(
            f"Proxy response: {response.status_code}",
            extra={
                "status_code": response.status_code,
                "target_url": target_url,
            },
        )

        # Return response with preserved headers and status
        return Response(
            content=response.content,
            status_code=response.status_code,
            headers=dict(response.headers),
            media_type=response.headers.get("content-type"),
        )

    except httpx.ConnectError as e:
        logger.error(
            f"Agent work orders service unavailable at {service_url}",
            extra={
                "error": str(e),
                "service_url": service_url,
            },
            exc_info=True,
        )
        raise HTTPException(
            status_code=503,
            detail="Agent work orders service is currently unavailable",
        ) from e

    except httpx.TimeoutException as e:
        logger.error(
            "Agent work orders service timeout",
            extra={
                "error": str(e),
                "service_url": service_url,
                "target_url": target_url,
            },
            exc_info=True,
        )
        raise HTTPException(
            status_code=504,
            detail="Agent work orders service request timed out",
        ) from e

    except Exception as e:
        logger.error(
            "Error proxying to agent work orders service",
            extra={
                "error": str(e),
                "service_url": service_url,
                "method": request.method,
                "path": request.url.path,
            },
            exc_info=True,
        )
        raise HTTPException(
            status_code=500,
            detail="Internal server error while contacting agent work orders service",
        ) from e
