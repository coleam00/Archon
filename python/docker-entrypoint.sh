#!/bin/sh
# This entrypoint script ensures that network-dependent services are available
# before starting the main application.

# Exit immediately if a command exits with a non-zero status.
set -e

# Run the network connectivity verification script.
# This script will block and retry until Supabase is reachable.
echo "[entrypoint] Running network preflight check for Supabase..."
python /app/verify_network_connectivity.py

# If the verification script succeeds, execute the main command (CMD) 
# provided to the container.
echo "[entrypoint] Network check passed. Starting application..."
exec "$@"
