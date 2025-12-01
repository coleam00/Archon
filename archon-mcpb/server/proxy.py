#!/usr/bin/env python3
"""
Archon MCP Proxy - Lightweight connection proxy for MCPB

This proxy forwards MCP requests from Claude Desktop (or other MCPB clients)
to the running Archon MCP server at http://localhost:8051/mcp (configurable).

Architecture:
  Claude Desktop → stdio → proxy.py → HTTP → localhost:8051/mcp → Archon MCP Server

Prerequisites:
  - Archon must be running: docker compose up -d
  - MCP server accessible at http://localhost:8051/mcp (default port, configurable)
"""

import asyncio
import json
import logging
import os
import sys
from typing import Any, Optional

try:
    import httpx
except ImportError:
    print("Error: httpx not installed. Run: pip install httpx", file=sys.stderr)
    sys.exit(1)

# Configure logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stderr  # Log to stderr to not interfere with stdio protocol
)
logger = logging.getLogger("archon-mcp-proxy")

# Set httpx to WARNING to reduce noise, but keep our logger at configured level
logging.getLogger("httpx").setLevel(logging.WARNING)

# Configuration
ARCHON_API_URL = os.getenv("ARCHON_API_URL", "http://localhost:8181")
ARCHON_MCP_PORT = os.getenv("ARCHON_MCP_PORT", "8051")
ARCHON_MCP_URL = f"http://localhost:{ARCHON_MCP_PORT}/mcp"
CONNECTION_TIMEOUT = 5.0
REQUEST_TIMEOUT = 30.0

# Session state - will be set after first successful request
mcp_session_id: Optional[str] = None


async def validate_archon_connection() -> tuple[bool, str]:
    """
    Validate that Archon backend is running and accessible.

    Checks the main API server's health endpoint rather than the MCP endpoint,
    since the MCP endpoint expects SSE connections with proper protocol messages.

    Returns:
        tuple: (is_connected, error_message)
    """
    try:
        async with httpx.AsyncClient(timeout=CONNECTION_TIMEOUT) as client:
            # Check main API server health endpoint
            health_url = f"{ARCHON_API_URL}/health"
            response = await client.get(health_url)

            if response.status_code == 200:
                health_data = response.json()
                if health_data.get("ready"):
                    logger.info(f"✓ Successfully connected to Archon at {ARCHON_API_URL}")
                    logger.info(f"  MCP endpoint will be: {ARCHON_MCP_URL}")
                    return True, ""
                else:
                    error_msg = f"Archon is starting up: {health_data.get('status', 'unknown')}"
                    logger.warning(f"⚠ {error_msg}")
                    return False, error_msg
            else:
                error_msg = f"Archon health check returned status {response.status_code}"
                logger.error(f"✗ {error_msg}")
                return False, error_msg

    except httpx.ConnectError:
        error_msg = (
            f"Cannot connect to Archon at {ARCHON_API_URL}\n"
            f"Please ensure Archon is running:\n"
            f"  cd archon\n"
            f"  docker compose up -d\n"
            f"Then verify: curl {ARCHON_API_URL}/health"
        )
        logger.error(f"✗ Connection failed: {error_msg}")
        return False, error_msg

    except httpx.TimeoutException:
        error_msg = f"Connection to Archon timed out after {CONNECTION_TIMEOUT}s"
        logger.error(f"✗ {error_msg}")
        return False, error_msg

    except Exception as e:
        error_msg = f"Unexpected error connecting to Archon: {type(e).__name__}: {e}"
        logger.error(f"✗ {error_msg}")
        return False, error_msg


async def forward_mcp_request(request_data: dict[str, Any]) -> dict[str, Any]:
    """
    Forward an MCP request to the Archon HTTP server.

    Args:
        request_data: MCP request as JSON-RPC dict

    Returns:
        MCP response as JSON-RPC dict
    """
    global mcp_session_id

    try:
        # Log the request we're forwarding
        logger.info(f"Forwarding MCP request: method={request_data.get('method')}, id={request_data.get('id')}")

        # Build headers
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream"
        }

        # Include session ID if we have one
        if mcp_session_id:
            headers["mcp-session-id"] = mcp_session_id
            logger.info(f"📤 Including session ID in request: {mcp_session_id}")

        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            # Forward request to Archon MCP HTTP endpoint
            response = await client.post(
                ARCHON_MCP_URL,
                json=request_data,
                headers=headers
            )

            # Log all response headers to understand session management
            logger.info(f"Response headers: {list(response.headers.keys())}")

            # Extract session ID from response headers if present
            # FastMCP uses 'mcp-session-id' header
            session_id_header = response.headers.get("mcp-session-id")
            if session_id_header and not mcp_session_id:
                mcp_session_id = session_id_header
                logger.info(f"📝 Stored MCP session ID: {mcp_session_id}")

            # Log response details for debugging
            logger.info(f"MCP Response - Status: {response.status_code}, Content-Type: {response.headers.get('Content-Type', 'unknown')}, Length: {len(response.content)} bytes")
            if len(response.content) > 0 and len(response.content) < 1000:
                logger.info(f"MCP Response content: {response.text}")
            elif len(response.content) > 0:
                logger.info(f"MCP Response preview: {response.text[:500]}...")

            if response.status_code == 200 or response.status_code == 202:
                # Check if response has content
                if not response.content or len(response.content) == 0:
                    # Empty response - this might be expected for some MCP operations
                    logger.warning(f"Empty response from MCP server for request: {request_data.get('method')}")
                    return {
                        "jsonrpc": "2.0",
                        "id": request_data.get("id"),
                        "result": {}
                    }

                # Check content type
                content_type = response.headers.get("Content-Type", "")

                if "application/json" in content_type:
                    # Parse as JSON
                    try:
                        return response.json()
                    except json.JSONDecodeError as e:
                        logger.error(f"Failed to decode JSON response: {e}")
                        logger.error(f"Response content: {response.text[:200]}")
                        return {
                            "jsonrpc": "2.0",
                            "id": request_data.get("id"),
                            "error": {
                                "code": -32603,
                                "message": f"Invalid JSON in response: {str(e)}"
                            }
                        }
                elif "text/event-stream" in content_type:
                    # SSE response - parse the SSE events
                    # SSE format can be multi-line:
                    # event: message
                    # data: {json}
                    #
                    # Or single line:
                    # data: {json}
                    text = response.text.strip()
                    lines = text.split('\n')

                    # Find lines starting with "data: " and extract JSON
                    json_data = None
                    for line in lines:
                        line = line.strip()
                        if line.startswith("data: "):
                            json_data = line[6:]  # Remove "data: " prefix
                            break

                    if json_data:
                        try:
                            result = json.loads(json_data)
                            logger.info(f"Successfully parsed SSE response")
                            return result
                        except json.JSONDecodeError as e:
                            logger.error(f"Failed to decode SSE JSON: {e}")
                            logger.error(f"JSON data was: {json_data[:200]}")
                            return {
                                "jsonrpc": "2.0",
                                "id": request_data.get("id"),
                                "error": {
                                    "code": -32603,
                                    "message": f"Invalid SSE JSON: {str(e)}"
                                }
                            }
                    else:
                        logger.error(f"No 'data:' line found in SSE response. Lines: {lines[:5]}")
                        return {
                            "jsonrpc": "2.0",
                            "id": request_data.get("id"),
                            "error": {
                                "code": -32603,
                                "message": "No data line found in SSE response"
                            }
                        }
                else:
                    # Unknown content type
                    logger.warning(f"Unexpected content type: {content_type}")
                    logger.warning(f"Response content: {response.text[:200]}")
                    # Try to parse as JSON anyway
                    try:
                        return response.json()
                    except:
                        return {
                            "jsonrpc": "2.0",
                            "id": request_data.get("id"),
                            "error": {
                                "code": -32603,
                                "message": f"Unexpected content type: {content_type}"
                            }
                        }
            else:
                # Return JSON-RPC error
                return {
                    "jsonrpc": "2.0",
                    "id": request_data.get("id"),
                    "error": {
                        "code": -32603,
                        "message": f"Archon server returned status {response.status_code}",
                        "data": response.text
                    }
                }

    except httpx.TimeoutException:
        return {
            "jsonrpc": "2.0",
            "id": request_data.get("id"),
            "error": {
                "code": -32603,
                "message": f"Request timeout after {REQUEST_TIMEOUT}s"
            }
        }
    except Exception as e:
        return {
            "jsonrpc": "2.0",
            "id": request_data.get("id"),
            "error": {
                "code": -32603,
                "message": f"Proxy error: {type(e).__name__}: {e}"
            }
        }


async def stdio_proxy_loop():
    """
    Main proxy loop: read from stdin, forward to Archon HTTP, write to stdout.
    Implements JSON-RPC over stdio protocol.

    Uses a Windows-compatible approach for stdin/stdout handling.
    """
    logger.info("Starting stdio proxy loop...")

    # Use a separate thread for blocking stdin reads (works on all platforms)
    import threading
    from queue import Queue

    input_queue: Queue = Queue()

    def stdin_reader():
        """Read from stdin in a separate thread (blocking I/O)."""
        try:
            while True:
                line = sys.stdin.readline()
                if not line:
                    input_queue.put(None)  # EOF signal
                    break
                input_queue.put(line)
        except Exception as e:
            logger.error(f"Error in stdin reader thread: {e}")
            input_queue.put(None)

    # Start stdin reader thread
    reader_thread = threading.Thread(target=stdin_reader, daemon=True)
    reader_thread.start()

    while True:
        try:
            # Get input from queue with timeout to allow for graceful shutdown
            loop = asyncio.get_event_loop()
            line = await loop.run_in_executor(None, input_queue.get, True, 1.0)

            if line is None:
                logger.info("EOF received, shutting down proxy")
                break

            try:
                request = json.loads(line)
                logger.debug(f"Received request: {request.get('method', 'unknown')}")

                # Check if this is a notification (no 'id' field or id is None)
                is_notification = 'id' not in request or request.get('id') is None

                # Forward to Archon
                response = await forward_mcp_request(request)

                # Only send response for requests (not notifications)
                if not is_notification:
                    response_line = json.dumps(response) + "\n"
                    sys.stdout.write(response_line)
                    sys.stdout.flush()
                    logger.debug(f"Sent response for request id: {request.get('id')}")
                else:
                    logger.debug(f"Notification processed (no response sent): {request.get('method')}")

            except json.JSONDecodeError as e:
                logger.error(f"Invalid JSON received: {e}")
                # Send error response
                error_response = {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {
                        "code": -32700,
                        "message": "Parse error: Invalid JSON"
                    }
                }
                sys.stdout.write(json.dumps(error_response) + "\n")
                sys.stdout.flush()

        except Exception as e:
            # Check if it's just a timeout (normal operation)
            if "Empty" in str(type(e).__name__):
                # Queue timeout - just continue
                continue
            logger.error(f"Error in proxy loop: {e}", exc_info=True)
            break


async def main():
    """Main entry point for the proxy."""
    logger.info("=" * 60)
    logger.info("Archon MCP Proxy (MCPB Bundle)")
    logger.info("=" * 60)
    logger.info(f"Archon API: {ARCHON_API_URL}")
    logger.info(f"MCP Target: {ARCHON_MCP_URL}")
    logger.info(f"Log Level: {LOG_LEVEL}")
    logger.info("")

    # Validate connection to Archon before starting
    is_connected, error_msg = await validate_archon_connection()

    if not is_connected:
        logger.error("=" * 60)
        logger.error("STARTUP FAILED - Archon Not Accessible")
        logger.error("=" * 60)
        logger.error(error_msg)
        logger.error("")
        logger.error("Troubleshooting:")
        logger.error("1. Start Archon: docker compose up -d")
        logger.error("2. Verify backend: curl http://localhost:8181/health")
        logger.error("3. Check logs: docker compose logs archon-server archon-mcp")
        logger.error("=" * 60)

        # Send initialization error via JSON-RPC
        error_response = {
            "jsonrpc": "2.0",
            "id": None,
            "error": {
                "code": -32603,
                "message": "Archon backend not accessible",
                "data": error_msg
            }
        }
        sys.stdout.write(json.dumps(error_response) + "\n")
        sys.stdout.flush()
        sys.exit(1)

    logger.info("=" * 60)
    logger.info("✓ Proxy ready - forwarding MCP requests to Archon")
    logger.info("=" * 60)
    logger.info("")

    # Start stdio proxy loop
    try:
        await stdio_proxy_loop()
    except KeyboardInterrupt:
        logger.info("Received interrupt signal, shutting down...")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Proxy stopped by user")
    except Exception as e:
        logger.error(f"Unhandled exception: {e}", exc_info=True)
        sys.exit(1)
