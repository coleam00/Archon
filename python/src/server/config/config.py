"""
Environment configuration management for the MCP server.
"""

import ipaddress
import os
from dataclasses import dataclass
from urllib.parse import urlparse

from jose import jwt


class ConfigurationError(Exception):
    """Raised when there's an error in configuration."""

    pass


@dataclass
class EnvironmentConfig:
    """Configuration loaded from environment variables."""

    supabase_url: str
    supabase_service_key: str
    port: int  # Required - no default
    openai_api_key: str | None = None
    host: str = "0.0.0.0"
    transport: str = "sse"


@dataclass
class RAGStrategyConfig:
    """Configuration for RAG strategies."""

    use_contextual_embeddings: bool = False
    use_hybrid_search: bool = True
    use_agentic_rag: bool = True
    use_reranking: bool = True


def validate_openai_api_key(api_key: str) -> bool:
    """Validate OpenAI API key format."""
    if not api_key:
        raise ConfigurationError("OpenAI API key cannot be empty")

    if not api_key.startswith("sk-"):
        raise ConfigurationError("OpenAI API key must start with 'sk-'")

    return True


def validate_supabase_key(supabase_key: str) -> tuple[bool, str]:
    """Validate Supabase key type and return validation result.

    Returns:
        tuple[bool, str]: (is_valid, message)
        - (False, "ANON_KEY_DETECTED") if anon key detected
        - (True, "VALID_SERVICE_KEY") if service key detected
        - (False, "UNKNOWN_KEY_TYPE:{role}") for unknown roles
        - (True, "UNABLE_TO_VALIDATE") if JWT cannot be decoded
    """
    if not supabase_key:
        return False, "EMPTY_KEY"

    try:
        # Decode JWT without verification to check the 'role' claim
        # We don't verify the signature since we only need to check the role
        # Also skip all other validations (aud, exp, etc) since we only care about the role
        decoded = jwt.decode(
            supabase_key,
            '',
            options={
                "verify_signature": False,
                "verify_aud": False,
                "verify_exp": False,
                "verify_nbf": False,
                "verify_iat": False
            }
        )
        role = decoded.get("role")

        if role == "anon":
            return False, "ANON_KEY_DETECTED"
        elif role == "service_role":
            return True, "VALID_SERVICE_KEY"
        else:
            return False, f"UNKNOWN_KEY_TYPE:{role}"

    except Exception:
        # If we can't decode the JWT, we'll allow it to proceed
        # This handles new key formats or non-JWT keys
        return True, "UNABLE_TO_VALIDATE"


def validate_supabase_url(url: str) -> bool:
    """Validate Supabase URL format."""
    if not url:
        raise ConfigurationError("Supabase URL cannot be empty")

    parsed = urlparse(url)
    # Allow HTTP for local development (host.docker.internal or localhost)
    if parsed.scheme not in ("http", "https"):
        raise ConfigurationError("Supabase URL must use HTTP or HTTPS")

    # Require HTTPS for production (non-local) URLs
    if parsed.scheme == "http":
        hostname = parsed.hostname or ""

        # Check for exact localhost and Docker internal hosts (security: prevent subdomain bypass)
        local_hosts = ["localhost", "127.0.0.1", "host.docker.internal"]
        if hostname in local_hosts or hostname.endswith(".localhost"):
            return True

        # Check if hostname is a private IP address
        try:
            ip = ipaddress.ip_address(hostname)
            # Allow HTTP for private IP addresses (RFC 1918)
            # Class A: 10.0.0.0/8
            # Class B: 172.16.0.0/12
            # Class C: 192.168.0.0/16
            # Also includes link-local (169.254.0.0/16) and loopback
            # Exclude unspecified address (0.0.0.0) for security
            if (ip.is_private or ip.is_loopback or ip.is_link_local) and not ip.is_unspecified:
                return True
        except ValueError:
            # hostname is not a valid IP address, could be a domain name
            pass

        # If not a local host or private IP, require HTTPS
        raise ConfigurationError(f"Supabase URL must use HTTPS for non-local environments (hostname: {hostname})")

    if not parsed.netloc:
        raise ConfigurationError("Invalid Supabase URL format")

    return True


def load_environment_config() -> EnvironmentConfig:
    """Load and validate environment configuration."""
    # OpenAI API key is optional at startup - can be set via API
    openai_api_key = os.getenv("OPENAI_API_KEY")

    # Required environment variables for database access
    supabase_url = os.getenv("SUPABASE_URL")
    if not supabase_url:
        raise ConfigurationError("SUPABASE_URL environment variable is required")

    supabase_service_key = os.getenv("SUPABASE_SERVICE_KEY")
    if not supabase_service_key:
        raise ConfigurationError("SUPABASE_SERVICE_KEY environment variable is required")

    # Validate required fields
    if openai_api_key:
        validate_openai_api_key(openai_api_key)
    validate_supabase_url(supabase_url)

    # Validate Supabase key type
    is_valid_key, key_message = validate_supabase_key(supabase_service_key)
    if not is_valid_key:
        if key_message == "ANON_KEY_DETECTED":
            raise ConfigurationError(
                "CRITICAL: You are using a Supabase ANON key instead of a SERVICE key.\n\n"
                "The ANON key is a public key with read-only permissions that cannot write to the database.\n"
                "This will cause all database operations to fail with 'permission denied' errors.\n\n"
                "To fix this:\n"
                "1. Go to your Supabase project dashboard\n"
                "2. Navigate to Settings > API keys\n"
                "3. Find the 'service_role' key (NOT the 'anon' key)\n"
                "4. Update your SUPABASE_SERVICE_KEY environment variable\n\n"
                "Key characteristics:\n"
                "- ANON key: Starts with 'eyJ...' and has role='anon' (public, read-only)\n"
                "- SERVICE key: Starts with 'eyJ...' and has role='service_role' (private, full access)\n\n"
                "Current key role detected: anon"
            )
        elif key_message.startswith("UNKNOWN_KEY_TYPE:"):
            role = key_message.split(":", 1)[1]
            raise ConfigurationError(
                f"CRITICAL: Unknown Supabase key role '{role}'.\n\n"
                f"Expected 'service_role' but found '{role}'.\n"
                f"This key type is not supported and will likely cause failures.\n\n"
                f"Please use a valid service_role key from your Supabase dashboard."
            )
        # For UNABLE_TO_VALIDATE, we continue silently

    # Optional environment variables with defaults
    host = os.getenv("HOST", "0.0.0.0")
    port_str = os.getenv("PORT")
    if not port_str:
        # This appears to be for MCP configuration based on default 8051
        port_str = os.getenv("ARCHON_MCP_PORT")
        if not port_str:
            raise ConfigurationError(
                "PORT or ARCHON_MCP_PORT environment variable is required. "
                "Please set it in your .env file or environment. "
                "Default value: 8051"
            )
    transport = os.getenv("TRANSPORT", "sse")

    # Validate and convert port
    try:
        port = int(port_str)
    except ValueError as e:
        raise ConfigurationError(f"PORT must be a valid integer, got: {port_str}") from e

    return EnvironmentConfig(
        openai_api_key=openai_api_key,
        supabase_url=supabase_url,
        supabase_service_key=supabase_service_key,
        host=host,
        port=port,
        transport=transport,
    )


def get_config() -> EnvironmentConfig:
    """Get environment configuration with validation."""
    return load_environment_config()


def get_rag_strategy_config() -> RAGStrategyConfig:
    """Load RAG strategy configuration from environment variables."""

    def str_to_bool(value: str | None) -> bool:
        """Convert string environment variable to boolean."""
        if value is None:
            return False
        return value.lower() in ("true", "1", "yes", "on")

    return RAGStrategyConfig(
        use_contextual_embeddings=str_to_bool(os.getenv("USE_CONTEXTUAL_EMBEDDINGS")),
        use_hybrid_search=str_to_bool(os.getenv("USE_HYBRID_SEARCH")),
        use_agentic_rag=str_to_bool(os.getenv("USE_AGENTIC_RAG")),
        use_reranking=str_to_bool(os.getenv("USE_RERANKING")),
    )
