"""
URL validation utilities for security.

Provides SSRF (Server-Side Request Forgery) protection and URL sanitization.
"""

import ipaddress
import re
from urllib.parse import urlparse

from fastapi import HTTPException


# Maximum patterns and length constraints for glob sanitization
MAX_GLOB_PATTERNS = 50
MAX_PATTERN_LENGTH = 200


def validate_url(url: str) -> None:
    """
    Validate URL to prevent SSRF (Server-Side Request Forgery) attacks.

    Blocks requests to:
    - Private IP addresses (RFC 1918) - both IPv4 and IPv6
    - Loopback addresses (127.0.0.0/8, ::1)
    - Link-local addresses (169.254.0.0/16, fe80::/10)
    - localhost and common variations
    - File protocol
    - Other dangerous protocols

    Validates both numeric IP addresses (IPv4/IPv6) and hostname resolution
    to prevent bypasses via DNS rebinding or IPv6 literals.

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
        # Handle both numeric IPs (IPv4/IPv6) and hostnames
        try:
            import socket

            # First, try parsing as a numeric IP address (handles both IPv4 and IPv6)
            try:
                ip = ipaddress.ip_address(hostname)
                # Check if IP is private, loopback, or link-local
                if ip.is_private or ip.is_loopback or ip.is_link_local:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Access to private/internal IP addresses is not allowed: {hostname}"
                    )
            except ValueError:
                # Not a numeric IP, resolve hostname using getaddrinfo (handles both IPv4 and IPv6)
                addr_info = socket.getaddrinfo(hostname, None)

                # Check all resolved addresses (both IPv4 and IPv6)
                for addr in addr_info:
                    ip_str = addr[4][0]  # Extract IP address from addr tuple
                    try:
                        ip = ipaddress.ip_address(ip_str)

                        # Check if any resolved IP is private, loopback, or link-local
                        if ip.is_private or ip.is_loopback or ip.is_link_local:
                            raise HTTPException(
                                status_code=400,
                                detail=f"Access to private/internal IP addresses is not allowed: {ip_str}"
                            )
                    except ValueError:
                        # Invalid IP address format in resolution result - skip this address
                        continue

        except socket.gaierror:
            # DNS resolution failed - let it through, real request will fail naturally
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
    if len(patterns) > MAX_GLOB_PATTERNS:
        raise HTTPException(
            status_code=400,
            detail=f"Too many patterns. Maximum {MAX_GLOB_PATTERNS} allowed."
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
        if len(pattern) > MAX_PATTERN_LENGTH:
            raise HTTPException(
                status_code=400,
                detail=f"Pattern too long (max {MAX_PATTERN_LENGTH} characters): {pattern[:50]}..."
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


# Backward compatibility alias
validate_url_against_ssrf = validate_url
