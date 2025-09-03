"""ETag utilities for HTTP caching and efficient polling."""

import hashlib
import json
from typing import Any


def generate_etag(data: Any) -> str:
    """Generate an ETag hash from data.
    
    Args:
        data: Any JSON-serializable data to hash
        
    Returns:
        ETag string (MD5 hash of JSON representation)
    """
    # Convert data to stable JSON string
    json_str = json.dumps(data, sort_keys=True, default=str)

    # Generate MD5 hash
    hash_obj = hashlib.md5(json_str.encode('utf-8'))

    # Return ETag in standard format (quoted)
    return f'"{hash_obj.hexdigest()}"'


def check_etag(request_etag: str | None, current_etag: str) -> bool:
    """Check if request ETag matches current ETag.
    
    Args:
        request_etag: ETag from If-None-Match header
        current_etag: Current ETag of the data
        
    Returns:
        True if ETags match (data unchanged), False otherwise
    """
    if not request_etag:
        return False

    # Both ETags should have quotes, compare directly
    # The If-None-Match header and our generated ETag should both be quoted
    return request_etag == current_etag
