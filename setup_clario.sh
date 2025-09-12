#!/bin/bash

# Clario Setup Script
# Sets up Clario knowledge engine on top of Archon's proven infrastructure

echo "🎯 Clario Knowledge Engine Setup"
echo "Built on Archon's proven infrastructure"
echo "=================================="

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Check if we're in the right directory (should have Archon structure)
if [ ! -f "docker-compose.yml" ] || [ ! -d "python/src/server" ]; then
    echo -e "${RED}❌ Not in Archon repository root.${NC}"
    echo "This script should be run from the root of the forked Archon repository."
    exit 1
fi

echo -e "\n${BLUE}Step 1: Verifying Archon base infrastructure...${NC}"

# Check essential Archon files
essential_files=(
    "python/src/server/services/storage/document_storage_service.py"
    "python/src/server/services/search/rag_service.py"
    "python/src/server/utils/__init__.py"
    "docker-compose.yml"
    ".env.example"
)

for file in "${essential_files[@]}"; do
    if [ -f "$file" ]; then
        echo -e "✅ $file"
    else
        echo -e "${RED}❌ $file missing${NC}"
        echo "Please ensure you have the complete Archon repository."
        exit 1
    fi
done

echo -e "\n${BLUE}Step 2: Checking environment configuration...${NC}"

if [ ! -f ".env" ]; then
    echo -e "${YELLOW}⚠️ Creating .env from template...${NC}"
    cp .env.example .env
    echo -e "${YELLOW}Please edit .env with your credentials:${NC}"
    echo "  SUPABASE_URL=https://your-project.supabase.co"
    echo "  SUPABASE_SERVICE_KEY=your-service-key"
    echo "  OPENAI_API_KEY=your-openai-key"
    echo ""
    read -p "Press Enter after configuring .env..."
fi

echo -e "\n${BLUE}Step 3: Installing Clario dependencies...${NC}"

# Install additional dependencies for Clario extensions
if command -v uv >/dev/null 2>&1; then
    echo "Using uv package manager..."
    cd python && uv add httpx pydantic[email] && cd ..
elif command -v pip >/dev/null 2>&1; then
    echo "Using pip..."
    pip install httpx "pydantic[email]"
else
    echo -e "${RED}❌ No Python package manager found (pip or uv)${NC}"
    exit 1
fi

echo -e "\n${BLUE}Step 4: Verifying Clario extensions...${NC}"

# Check our extension files
clario_files=(
    "extensions/n8n_integration/ingestion_api.py"
    "extensions/unified_search/archon_search.py"
    "clario_app.py"
)

for file in "${clario_files[@]}"; do
    if [ -f "$file" ]; then
        echo -e "✅ $file"
    else
        echo -e "${RED}❌ $file missing${NC}"
        echo "Clario extensions not properly installed."
        exit 1
    fi
done

echo -e "\n${BLUE}Step 5: Starting Archon services...${NC}"

# Start Archon's proven infrastructure
echo "Starting Archon services (this provides the foundation for Clario)..."
docker-compose up -d

# Wait for services
echo "Waiting for Archon services to start..."
sleep 15

# Check if Archon services are running
check_service() {
    local service=$1
    local port=$2
    local name=$3
    
    if curl -s "http://localhost:$port/health" >/dev/null 2>&1; then
        echo -e "✅ $name: http://localhost:$port"
        return 0
    else
        echo -e "${RED}❌ $name: Not responding on port $port${NC}"
        return 1
    fi
}

services_ok=true
check_service "archon-server" 8181 "Archon API" || services_ok=false
check_service "archon-mcp" 8051 "Archon MCP" || services_ok=false

if ! $services_ok; then
    echo -e "\n${RED}❌ Archon services not fully started.${NC}"
    echo "Check logs: docker-compose logs"
    echo "Ensure .env is configured correctly."
    exit 1
fi

echo -e "\n${BLUE}Step 6: Testing Clario integration...${NC}"

# Test that Clario can import Archon modules
python3 -c "
import sys
sys.path.append('.')

try:
    from python.src.server.utils import get_supabase_client
    from python.src.server.services.search.rag_service import RAGService
    from extensions.unified_search.archon_search import ArchonUnifiedSearch
    print('✅ Clario can import Archon modules successfully')
except ImportError as e:
    print(f'❌ Import error: {e}')
    sys.exit(1)
"

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Clario integration test failed${NC}"
    exit 1
fi

echo -e "\n${BLUE}Step 7: Starting Clario API...${NC}"

# Start Clario API server
echo "Starting Clario Knowledge Engine..."
python3 clario_app.py &
CLARIO_PID=$!

# Wait for Clario to start
sleep 8

# Test Clario health
if curl -s "http://localhost:8080/health" >/dev/null 2>&1; then
    echo -e "✅ Clario API: http://localhost:8080"
else
    echo -e "${RED}❌ Clario API failed to start${NC}"
    kill $CLARIO_PID 2>/dev/null
    echo "Check console output above for errors."
    exit 1
fi

echo -e "\n${GREEN}🎉 Clario is running successfully!${NC}"
echo "=================================="
echo -e "🧠 ${BLUE}Archon API:${NC}     http://localhost:8181 (proven infrastructure)"
echo -e "📊 ${BLUE}Archon UI:${NC}      http://localhost:3737 (knowledge base view)"
echo -e "🔍 ${BLUE}Archon MCP:${NC}     http://localhost:8051 (AI assistant integration)"
echo -e "⚡ ${BLUE}Clario API:${NC}     http://localhost:8080 (business intelligence layer)"
echo -e "📖 ${BLUE}Clario Docs:${NC}    http://localhost:8080/docs (API documentation)"

echo -e "\n${BLUE}Next Steps:${NC}"
echo "1. 🔧 Start n8n: docker run -d -p 5678:5678 -v n8n_data:/home/node/.n8n n8nio/n8n"
echo "2. 🔗 Open n8n UI: http://localhost:5678"
echo "3. 📋 Create workflows using examples in N8N_INTEGRATION_STRATEGY.md"
echo "4. 🎯 Integrate with Founder's command palette"

echo -e "\n${YELLOW}Quick Tests:${NC}"
echo "# Test Clario health:"
echo "curl http://localhost:8080/health"
echo ""
echo "# Test n8n connection:"
echo "curl -X POST http://localhost:8080/api/n8n/test-connection -H 'Content-Type: application/json' -d '{}'"

echo -e "\n${YELLOW}Example n8n → Clario test:${NC}"
echo "curl -X POST http://localhost:8080/api/n8n/ingest \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{
    \"platform\": \"jira\",
    \"entity_type\": \"issue\",
    \"entity_id\": \"TEST-123\",
    \"title\": \"TEST-123: Sample authentication issue\",
    \"content\": \"Users experiencing login problems with JWT tokens\",
    \"url\": \"https://company.atlassian.net/browse/TEST-123\",
    \"metadata\": {
      \"project_key\": \"TEST\",
      \"status\": \"Open\",
      \"priority\": \"High\"
    },
    \"business_context\": {
      \"platform\": \"jira\",
      \"entity_type\": \"issue\"
    }
  }'"

echo -e "\n${GREEN}🚀 Ready to transform Founder into a company-wide AI assistant!${NC}"

# Keep script running to show logs
echo -e "\n${BLUE}Clario logs (Ctrl+C to stop all services):${NC}"
trap "echo -e '\n${YELLOW}Stopping services...${NC}'; docker-compose down; kill $CLARIO_PID 2>/dev/null; exit" INT

wait $CLARIO_PID
