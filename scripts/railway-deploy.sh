#!/bin/bash

# Railway Automated Deployment Script
# This script automates the entire Railway deployment process

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Project configuration
PROJECT_NAME="archon-production"
SERVICES=("archon-server" "archon-mcp" "archon-frontend")

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_TEMPLATES_DIR="$PROJECT_ROOT/railway-env-templates"

# Helper functions
print_header() {
    echo -e "\n${BLUE}================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}================================${NC}\n"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

# Check if Railway CLI is installed
check_railway_cli() {
    print_header "Step 1: Checking Railway CLI Installation"

    if ! command -v railway &> /dev/null; then
        print_error "Railway CLI is not installed"
        echo ""
        echo "Please install Railway CLI first:"
        echo "  npm install -g @railway/cli"
        echo ""
        echo "Or use the install script:"
        echo "  curl -fsSL https://railway.app/install.sh | sh"
        echo ""
        echo "Or with Homebrew:"
        echo "  brew install railway"
        exit 1
    fi

    RAILWAY_VERSION=$(railway --version)
    print_success "Railway CLI is installed: $RAILWAY_VERSION"
}

# Check if user is logged in
check_railway_login() {
    print_header "Step 2: Verifying Railway Authentication"

    if ! railway whoami &> /dev/null; then
        print_error "Not logged in to Railway"
        echo ""
        print_info "Opening login flow..."
        railway login

        if ! railway whoami &> /dev/null; then
            print_error "Login failed"
            exit 1
        fi
    fi

    USER=$(railway whoami)
    print_success "Logged in as: $USER"
}

# Initialize Railway project
init_railway_project() {
    print_header "Step 3: Initializing Railway Project"

    # Check if already linked to a project
    if railway status &> /dev/null; then
        print_warning "Already linked to a Railway project"
        CURRENT_PROJECT=$(railway status | grep "Project:" | cut -d: -f2 | xargs)
        print_info "Current project: $CURRENT_PROJECT"

        read -p "Do you want to use this project? (y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            print_info "Please unlink first: rm -rf .railway"
            exit 1
        fi
    else
        print_info "Creating new Railway project: $PROJECT_NAME"
        railway init --name "$PROJECT_NAME"

        if [ $? -eq 0 ]; then
            print_success "Railway project initialized"
        else
            print_error "Failed to initialize Railway project"
            exit 1
        fi
    fi
}

# Load and validate environment file
load_env_file() {
    local service=$1
    local env_file="$ENV_TEMPLATES_DIR/${service}.env"

    if [ ! -f "$env_file" ]; then
        print_warning "Environment template not found: $env_file"
        return 1
    fi

    # Check if it's still using placeholder values
    if grep -q "your-project.supabase.co" "$env_file" || \
       grep -q "your-service-role-key-here" "$env_file" || \
       grep -q "your-key-here" "$env_file"; then
        print_warning "Environment file contains placeholder values: $env_file"
        print_info "Please edit the file and add your actual values"
        return 1
    fi

    return 0
}

# Set environment variables for a service
set_service_variables() {
    local service=$1

    print_header "Step 4: Configuring $service Environment Variables"

    local env_file="$ENV_TEMPLATES_DIR/${service}.env"

    if ! load_env_file "$service"; then
        read -p "Do you want to set variables manually? (y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            print_warning "Skipping $service variable configuration"
            return 1
        fi

        print_info "Opening Railway dashboard for manual configuration..."
        railway service "$service"
        railway open

        read -p "Press Enter after you've set the variables in the dashboard..."
        return 0
    fi

    print_info "Loading variables from: $env_file"

    # Switch to service
    railway service "$service"

    # Import variables from file
    railway variables set --from-env-file "$env_file"

    if [ $? -eq 0 ]; then
        print_success "Variables configured for $service"
    else
        print_error "Failed to set variables for $service"
        return 1
    fi
}

# Configure all services
configure_services() {
    print_header "Step 4: Configuring All Services"

    for service in "${SERVICES[@]}"; do
        set_service_variables "$service"
    done

    print_success "All services configured"
}

# Deploy services
deploy_services() {
    print_header "Step 5: Deploying Services to Railway"

    for service in "${SERVICES[@]}"; do
        print_info "Deploying $service..."

        railway service "$service"
        railway up --detach

        if [ $? -eq 0 ]; then
            print_success "$service deployed"
        else
            print_error "Failed to deploy $service"
            return 1
        fi
    done

    print_success "All services deployed"
}

# Get service URLs
get_service_urls() {
    print_header "Step 6: Service URLs"

    for service in "${SERVICES[@]}"; do
        railway service "$service"
        URL=$(railway domain 2>/dev/null | grep "https://" | head -n 1 | xargs)

        if [ -n "$URL" ]; then
            echo -e "${GREEN}$service:${NC} $URL"
        else
            echo -e "${YELLOW}$service:${NC} No public URL yet (generating...)"
        fi
    done

    echo ""
    print_info "Note: URLs may take a few moments to become active"
}

# Wait for deployment to complete
wait_for_deployment() {
    print_header "Step 7: Waiting for Deployment"

    print_info "Monitoring deployment status..."
    sleep 5

    for service in "${SERVICES[@]}"; do
        print_info "Checking $service..."
        railway service "$service"

        # Show latest logs
        echo ""
        railway logs --lines 20
        echo ""
    done
}

# Run health checks
run_health_checks() {
    print_header "Step 8: Running Health Checks"

    # Get server URL
    railway service archon-server
    SERVER_URL=$(railway domain 2>/dev/null | grep "https://" | head -n 1 | xargs)

    if [ -n "$SERVER_URL" ]; then
        print_info "Testing archon-server health endpoint..."
        if curl -s "${SERVER_URL}/health" | grep -q "healthy"; then
            print_success "archon-server is healthy"
        else
            print_warning "archon-server health check failed (may still be starting)"
        fi
    fi

    # Get MCP URL
    railway service archon-mcp
    MCP_URL=$(railway domain 2>/dev/null | grep "https://" | head -n 1 | xargs)

    if [ -n "$MCP_URL" ]; then
        print_info "Testing archon-mcp health endpoint..."
        if curl -s "${MCP_URL}/health" | grep -q "healthy"; then
            print_success "archon-mcp is healthy"
        else
            print_warning "archon-mcp health check failed (may still be starting)"
        fi
    fi
}

# Update CORS configuration
update_cors() {
    print_header "Step 9: Updating CORS Configuration"

    # Get frontend URL
    railway service archon-frontend
    FRONTEND_URL=$(railway domain 2>/dev/null | grep "https://" | head -n 1 | xargs)

    if [ -n "$FRONTEND_URL" ]; then
        print_info "Frontend URL: $FRONTEND_URL"
        print_info "Updating CORS in archon-server..."

        railway service archon-server
        railway variables set "ALLOWED_ORIGINS=$FRONTEND_URL"

        print_success "CORS updated"
        print_info "Redeploying archon-server for changes to take effect..."
        railway up --detach

        print_success "archon-server redeployed with updated CORS"
    else
        print_warning "Frontend URL not available yet"
        print_info "You'll need to update CORS manually later:"
        echo "  railway service archon-server"
        echo "  railway variables set ALLOWED_ORIGINS=<frontend-url>"
        echo "  railway up"
    fi
}

# Print deployment summary
print_summary() {
    print_header "🎉 Deployment Complete!"

    echo "Your Archon application has been deployed to Railway!"
    echo ""
    echo "Next steps:"
    echo "1. Visit the frontend URL to access your application"
    echo "2. Monitor logs with: railway logs --follow"
    echo "3. View project in Railway dashboard: railway open"
    echo ""
    echo "Useful commands:"
    echo "  railway status          - View deployment status"
    echo "  railway logs --follow   - Stream logs"
    echo "  railway variables       - View environment variables"
    echo "  railway domain          - View service URLs"
    echo ""
    print_info "For more information, see RAILWAY_CLI_DEPLOYMENT.md"
}

# Interactive mode
interactive_mode() {
    print_header "Railway Deployment - Interactive Mode"

    echo "This script will:"
    echo "1. Verify Railway CLI is installed"
    echo "2. Check you're logged in"
    echo "3. Initialize Railway project"
    echo "4. Configure environment variables"
    echo "5. Deploy all services"
    echo "6. Run health checks"
    echo ""

    read -p "Continue? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_info "Deployment cancelled"
        exit 0
    fi
}

# Main execution
main() {
    # Check for interactive flag
    if [[ "$1" == "--interactive" ]]; then
        interactive_mode
    fi

    # Run deployment steps
    check_railway_cli
    check_railway_login
    init_railway_project
    configure_services
    deploy_services
    wait_for_deployment
    get_service_urls
    run_health_checks
    update_cors
    print_summary
}

# Run main function
main "$@"
