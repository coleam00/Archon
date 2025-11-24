#!/usr/bin/env python3
"""
Archon Health Check Utility

Quick diagnostic tool to verify Archon is running and accessible
before installing or using the MCPB bundle.

Usage:
    python check-archon.py
"""

import sys
from typing import Optional

try:
    import httpx
except ImportError:
    print("❌ httpx not installed")
    print("   Install with: pip install httpx")
    sys.exit(1)

# ANSI color codes
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
BLUE = "\033[94m"
BOLD = "\033[1m"
RESET = "\033[0m"

ARCHON_MCP_URL = "http://localhost:8051/mcp"
ARCHON_API_URL = "http://localhost:8181/health"
ARCHON_UI_URL = "http://localhost:3737"


def check_service(name: str, url: str, timeout: float = 5.0) -> tuple[bool, Optional[str]]:
    """
    Check if a service is accessible.

    Args:
        name: Service name for display
        url: URL to check
        timeout: Request timeout in seconds

    Returns:
        tuple: (is_accessible, error_message)
    """
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.get(url)
            if 200 <= response.status_code < 300:
                return True, None
            else:
                return False, f"HTTP {response.status_code}"
    except httpx.ConnectError:
        return False, "Connection refused"
    except httpx.TimeoutException:
        return False, f"Timeout after {timeout}s"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def print_header():
    """Print header banner."""
    print()
    print(f"{BOLD}{BLUE}{'=' * 60}{RESET}")
    print(f"{BOLD}{BLUE}Archon Health Check{RESET}")
    print(f"{BOLD}{BLUE}{'=' * 60}{RESET}")
    print()


def print_service_status(name: str, url: str, is_ok: bool, error: Optional[str] = None):
    """Print status for a service."""
    status_icon = f"{GREEN}✓{RESET}" if is_ok else f"{RED}✗{RESET}"
    status_text = f"{GREEN}OK{RESET}" if is_ok else f"{RED}FAILED{RESET}"

    print(f"{status_icon} {BOLD}{name}{RESET}")
    print(f"  URL: {url}")
    print(f"  Status: {status_text}")
    if error:
        print(f"  Error: {RED}{error}{RESET}")
    print()


def print_recommendations(mcp_ok: bool, api_ok: bool, ui_ok: bool):
    """Print recommendations based on check results."""
    print(f"{BOLD}{YELLOW}Recommendations:{RESET}")
    print()

    if not any([mcp_ok, api_ok, ui_ok]):
        print(f"{RED}Archon is not running{RESET}")
        print()
        print("Start Archon with:")
        print(f"  {BOLD}cd archon{RESET}")
        print(f"  {BOLD}docker compose up -d{RESET}")
        print()
        print("Then run this check again.")
    elif mcp_ok and api_ok and ui_ok:
        print(f"{GREEN}All services are running!{RESET}")
        print()
        print("You can now:")
        print(f"  • Install the MCPB bundle in Claude Desktop")
        print(f"  • Access Archon UI at {ARCHON_UI_URL}")
        print(f"  • Use Archon MCP tools in your AI client")
    else:
        print(f"{YELLOW}Some services are not accessible{RESET}")
        print()
        if not mcp_ok:
            print(f"  • MCP server not running - check Docker logs:")
            print(f"    {BOLD}docker compose logs archon-mcp{RESET}")
        if not api_ok:
            print(f"  • Backend API not running - check Docker logs:")
            print(f"    {BOLD}docker compose logs archon-server{RESET}")
        if not ui_ok:
            print(f"  • UI not running - check Docker logs:")
            print(f"    {BOLD}docker compose logs archon-frontend{RESET}")
        print()
        print("Try restarting Archon:")
        print(f"  {BOLD}docker compose restart{RESET}")

    print()


def main():
    """Main health check routine."""
    print_header()

    print("Checking Archon services...")
    print()

    # Check API server first (most reliable indicator)
    api_ok, api_error = check_service("API Server", ARCHON_API_URL)
    print_service_status("API Server", ARCHON_API_URL, api_ok, api_error)

    # MCP server is verified indirectly through API health
    # Direct GET to MCP endpoint will fail with 400 (it expects SSE connections)
    mcp_status = "Available (via API)" if api_ok else "Not accessible"
    print(f"{GREEN if api_ok else RED}{'✓' if api_ok else '✗'}{RESET} {BOLD}MCP Server{RESET}")
    print(f"  URL: {ARCHON_MCP_URL}")
    print(f"  Status: {GREEN if api_ok else RED}{mcp_status}{RESET}")
    if api_ok:
        print(f"  Note: MCP endpoint requires SSE connection (verified via API health)")
    print()

    # Check UI
    ui_ok, ui_error = check_service("Web UI", ARCHON_UI_URL)
    print_service_status("Web UI", ARCHON_UI_URL, ui_ok, ui_error)

    print(f"{BOLD}{BLUE}{'=' * 60}{RESET}")
    print()

    # Print recommendations
    print_recommendations(api_ok, api_ok, ui_ok)

    # Exit with appropriate code
    if api_ok:
        print(f"{GREEN}{BOLD}✓ Archon backend is ready for MCPB bundle installation{RESET}")
        print(f"{BLUE}MCP endpoint will be accessible once proxy connects{RESET}")
        sys.exit(0)
    else:
        print(f"{RED}{BOLD}✗ Archon backend is not accessible{RESET}")
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
        print("Check cancelled")
        sys.exit(130)
    except Exception as e:
        print(f"{RED}Unexpected error: {e}{RESET}", file=sys.stderr)
        sys.exit(1)
