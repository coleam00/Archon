"""
This script acts as a simple entry point to the centralized Supabase
connectivity verification function. It's used by the Docker entrypoint script
to ensure Supabase is ready before the main application starts.
"""

import asyncio
import os
import sys

# Add the source directory to the Python path to allow importing the credential service
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "src")))

from server.services.credential_service import verify_supabase_connection


if __name__ == "__main__":
    try:
        # Run the async verification function
        asyncio.run(verify_supabase_connection())
    except (ValueError, ImportError) as e:
        # Log errors to stderr and exit
        print(f"[ERROR] [preflight-check] {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n[INFO] [preflight-check] Verification cancelled by user.")
        sys.exit(1)