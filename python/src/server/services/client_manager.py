"""
Client Manager Service

Manages database and API client connections.
"""

import os
import re

from supabase import Client, create_client

from ..config.logfire_config import search_logger


def get_supabase_client() -> Client:
    """
    Get a Supabase client instance.

    In local database mode (LOCAL_DB=true), the URL points to the local
    PostgREST proxy and the key is a placeholder.

    Returns:
        Supabase client instance
    """
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_KEY")
    local_db = os.getenv("LOCAL_DB", "false").lower() == "true"

    if not url or not key:
        if local_db:
            local_rest_port = os.getenv("LOCAL_REST_PORT", "3002")
            url = f"http://archon-postgrest-proxy:{local_rest_port}"
            key = "local-db-key"
        else:
            raise ValueError(
                "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in environment variables "
                "(or set LOCAL_DB=true for local database mode)"
            )

    try:
        # Let Supabase handle connection pooling internally
        client = create_client(url, key)

        # Extract project ID from URL for logging purposes only
        match = re.match(r"https://([^.]+)\.supabase\.co", url)
        if match:
            project_id = match.group(1)
            search_logger.debug(f"Supabase client initialized - project_id={project_id}")
        elif local_db:
            search_logger.debug("Supabase client initialized - local database mode (PostgREST)")

        return client
    except Exception as e:
        search_logger.error(f"Failed to create Supabase client: {e}")
        raise
