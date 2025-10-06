#!/bin/bash

# This script provides advanced diagnostics for troubleshooting Archon's network
# connectivity to the local Supabase instance.

set -e # Exit on first error

# --- Configuration ---
ENV_FILE=".env"

# --- Helper Functions ---
info() {
    echo -e "\033[34m[INFO] $@\033[0m"
}

success() {
    echo -e "\033[32m[SUCCESS] $@\033[0m"
}

error() {
    echo -e "\033[31m[ERROR] $@\033[0m"
}

warning() {
    echo -e "\033[33m[WARNING] $@\033[0m"
}

# --- Pre-flight Checks ---
info "Starting network diagnostics..."

if [ ! -f "$ENV_FILE" ]; then
    error ".env file not found. Cannot proceed without Supabase configuration."
    exit 1
fi

source "$ENV_FILE"

if [ -z "$SUPABASE_URL" ]; then
    error "SUPABASE_URL is not set in your .env file."
    exit 1
fi

if ! command -v docker &> /dev/null; then
    error "Docker command not found. This script requires Docker to run."
    exit 1
fi

# --- Diagnostic Steps ---

# 1. Parse Supabase URL
info "1. Parsing SUPABASE_URL: $SUPABASE_URL"
HAS_PROTOCOL=$(echo "$SUPABASE_URL" | grep "://" || true)
if [ -z "$HAS_PROTOCOL" ]; then
    error "Invalid SUPABASE_URL format. It must include http:// or https://"
    exit 1
fi

HOSTNAME=$(echo "$SUPABASE_URL" | awk -F/ '{print $3}' | awk -F: '{print $1}')
PORT=$(echo "$SUPABASE_URL" | awk -F/ '{print $3}' | awk -F: '{print $2}' | sed 's|/.*||')
if [ -z "$PORT" ]; then
    # Default to 80 for http and 443 for https
    [[ "$SUPABASE_URL" == http://* ]] && PORT=80
    [[ "$SUPABASE_URL" == https://* ]] && PORT=443
fi

success "Parsed URL. Host: $HOSTNAME, Port: $PORT"

# 2. Host DNS Resolution
info "\n2. Checking DNS Resolution from Host"
if nslookup "$HOSTNAME" > /dev/null 2>&1; then
    IP_ADDRESS=$(nslookup "$HOSTNAME" | awk '/^Address: / {print $2}' | tail -n1)
    success "DNS resolved. '$HOSTNAME' points to $IP_ADDRESS"
else
    error "DNS resolution failed from host. Cannot resolve '$HOSTNAME'."
    warning "Check your /etc/hosts file or local DNS settings."
    exit 1
fi

# 3. Host TCP Connectivity
info "\n3. Checking TCP Connectivity from Host (to $HOSTNAME:$PORT)"
# Use a temporary file for curl output to avoid polluting stdout
TMP_FILE=$(mktemp)
if curl --connect-timeout 5 -v "$SUPABASE_URL" > "$TMP_FILE" 2>&1; then
    success "TCP connection successful."
else
    error "TCP connection failed from host to $HOSTNAME on port $PORT."
    cat "$TMP_FILE"
    rm "$TMP_FILE"
    exit 1
fi
rm "$TMP_FILE"

# 4. Docker Network and Container Checks
info "\n4. Checking Docker Environment"
KONG_CONTAINER=$(docker ps --filter "name=kong" --format "{{.Names}}" | head -n 1)
if [ -z "$KONG_CONTAINER" ]; then
    error "Supabase (Kong) container is not running. Start it with 'supabase start'."
    exit 1
fi
success "Supabase (Kong) container is running: $KONG_CONTAINER"

SUPABASE_NETWORK=$(docker inspect "$KONG_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' | head -n 1)
if [ -z "$SUPABASE_NETWORK" ]; then
    error "Could not determine the Docker network for the Supabase container."
    exit 1
fi
success "Supabase is on Docker network: $SUPABASE_NETWORK"

# 5. Docker DNS Resolution
info "\n5. Checking DNS Resolution from within Docker Network ($SUPABASE_NETWORK)"
DNS_TEST_CMD="nslookup $HOSTNAME"
if docker run --rm --network "$SUPABASE_NETWORK" appropriate/curl sh -c "$DNS_TEST_CMD"; then
    success "DNS for '$HOSTNAME' resolved correctly from within the Docker network."
else
    error "DNS for '$HOSTNAME' failed to resolve from inside the Docker network."
    warning "This is the most common issue. Your SUPABASE_URL hostname must be resolvable by other containers."
    warning "Using the IP address from step 2 ($IP_ADDRESS) might be a workaround."
    exit 1
fi

# 6. Docker HTTP Connectivity
info "\n6. Checking HTTP Connectivity from within Docker Network"
HTTP_TEST_CMD="curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 $SUPABASE_URL/rest/v1/"
HTTP_CODE=$(docker run --rm --network "$SUPABASE_NETWORK" appropriate/curl sh -c "$HTTP_TEST_CMD")

if [ "$HTTP_CODE" == "401" ]; then
    success "HTTP check passed. Received HTTP 401 Unauthorized, which is expected without an API key."
    info "This confirms the Archon server can reach the Supabase API gateway."
elif [ "$HTTP_CODE" == "200" ]; then
    success "HTTP check passed. Received HTTP 200 OK."
elif [ "$HTTP_CODE" == "000" ]; then
    error "HTTP check failed. Received status 000. This indicates a failure to connect."
    exit 1
else
    warning "HTTP check returned an unexpected status code: $HTTP_CODE"
fi

info "\n--- Diagnostics Complete ---"
success "All network checks passed. Your environment appears to be configured correctly."
