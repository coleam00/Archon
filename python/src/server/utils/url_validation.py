"""
URL validation utilities for security.

Provides SSRF (Server-Side Request Forgery) protection and URL sanitization.
"""

import ipaddress
import re
from urllib.parse import urlparse
from fastapi import HTTPException


def validate_url_against_ssrf(url: str) -> None:
    """
    Validate URL to prevent SSRF (Server-Side Request Forgery) attacks.

    Blocks requests to:
    - Private IP addresses (RFC 1918)
    - Loopback addresses
    - Link-local addresses
    - localhost and 127.0.0.1
    - File protocol
    - Other dangerous protocols

    Args:
        url: The URL to validate

    Raises:
        HTTPException: If URL is potentially dangerous
    """
    try:
        parsed = urlparse(url)

        # Check protocol
        if parsed.scheme not in ('http', 'https'):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid protocol: {parsed.scheme}. Only http and https are allowed."
            )

        # Get hostname
        hostname = parsed.hostname
        if not hostname:
            raise HTTPException(
                status_code=400,
                detail="Invalid URL: No hostname found"
            )

        # Block localhost variations
        localhost_patterns = [
            'localhost',
            '127.0.0.1',
            '0.0.0.0',
            '::1',
            'localhost.localdomain'
        ]

        if hostname.lower() in localhost_patterns:
            raise HTTPException(
                status_code=400,
                detail="Access to localhost is not allowed"
            )

        # Try to resolve hostname to IP and check if it's private
        try:
            import socket
            # Get IP address from hostname
            ip_str = socket.gethostbyname(hostname)
            ip = ipaddress.ip_address(ip_str)

            # Check if IP is private, loopback, or link-local
            if ip.is_private or ip.is_loopback or ip.is_link_local:
                raise HTTPException(
                    status_code=400,
                    detail=f"Access to private/internal IP addresses is not allowed: {ip_str}"
                )
        except socket.gaierror:
            # DNS resolution failed - let it through, real request will fail naturally
            pass
        except ValueError:
            # Invalid IP address format - let it through
            pass

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"URL validation failed: {str(e)}"
        )


def sanitize_glob_patterns(patterns: list[str] | None) -> list[str]:
    """
    Sanitize and validate glob patterns for URL filtering.

    Args:
        patterns: List of glob patterns to sanitize

    Returns:
        Sanitized list of patterns

    Raises:
        HTTPException: If patterns contain invalid characters
    """
    if not patterns:
        return []

    # Maximum number of patterns to prevent DoS
    MAX_PATTERNS = 50
    if len(patterns) > MAX_PATTERNS:
        raise HTTPException(
            status_code=400,
            detail=f"Too many patterns. Maximum {MAX_PATTERNS} allowed."
        )

    sanitized = []
    # Allow only safe characters in glob patterns
    # Valid: alphanumeric, -, _, /, *, ., ?, {, }, , (for glob alternation like *.{js,ts})
    safe_pattern = re.compile(r'^[a-zA-Z0-9\-_/*?.{},]+$')

    for pattern in patterns:
        # Trim whitespace
        pattern = pattern.strip()

        # Skip empty patterns
        if not pattern:
            continue

        # Maximum length per pattern
        if len(pattern) > 200:
            raise HTTPException(
                status_code=400,
                detail=f"Pattern too long (max 200 characters): {pattern[:50]}..."
            )

        # Check for dangerous characters
        if not safe_pattern.match(pattern):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid characters in pattern: {pattern}"
            )

        # Check for path traversal attempts
        if ".." in pattern:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid pattern: path traversal not allowed: {pattern}"
            )

        sanitized.append(pattern)

    return sanitized
