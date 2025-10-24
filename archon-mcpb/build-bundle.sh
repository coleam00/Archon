#!/usr/bin/env bash
#
# Archon MCP Proxy Bundle Builder
# Packages the lightweight proxy for easy Claude Desktop installation
#

set -e  # Exit on error

echo "=================================="
echo "Archon MCP Proxy Bundle Builder"
echo "=================================="
echo ""

# Check if we're in the right directory
if [ ! -f "manifest.json" ]; then
    echo "Error: Run this script from the archon-mcpb directory"
    echo "Usage: cd archon-mcpb && ./build-bundle.sh"
    exit 1
fi

# Check if MCPB CLI is installed
if ! command -v mcpb &> /dev/null; then
    echo "Error: MCPB CLI not found"
    echo "Install with: npm install -g @anthropic-ai/mcpb"
    exit 1
fi

echo "✓ MCPB CLI found"
echo ""

# Step 1: Validate proxy files exist
echo "Step 1: Validating proxy files..."
echo ""

if [ ! -f "server/proxy.py" ]; then
    echo "  ✗ Missing: server/proxy.py"
    exit 1
fi
echo "  ✓ proxy.py found"

if [ ! -f "server/requirements.txt" ]; then
    echo "  ✗ Missing: server/requirements.txt"
    exit 1
fi
echo "  ✓ requirements.txt found"

echo ""
echo "Step 2: Checking for icon..."
echo ""

if [ ! -f "icon.png" ]; then
    echo "  ⚠ Warning: icon.png not found"
    echo "    Bundle will be created without an icon"
    echo "    See ICON_PLACEHOLDER.txt to add one"
else
    echo "  ✓ icon.png found"
fi

echo ""
echo "Step 3: Packaging proxy bundle..."
echo ""

# Package the bundle
mcpb pack

# Rename to simple name (MCPB uses directory name for output)
if [ -f "archon-mcpb.mcpb" ]; then
    mv archon-mcpb.mcpb archon.mcpb
fi

# Check if bundle was created
if [ -f "archon.mcpb" ]; then
    BUNDLE_SIZE=$(ls -lh archon.mcpb | awk '{print $5}')
    echo ""
    echo "=================================="
    echo "✓ Proxy bundle created!"
    echo "=================================="
    echo ""
    echo "File: archon.mcpb"
    echo "Size: $BUNDLE_SIZE"
    echo ""
    echo "Next steps:"
    echo "1. Ensure Archon is running: docker compose up -d"
    echo "2. Install archon.mcpb in Claude Desktop"
    echo "3. Proxy will validate connection and forward requests"
    echo ""
    echo "Test connection first: python check-archon.py"
    echo ""
else
    echo "Error: Bundle packaging failed"
    exit 1
fi
