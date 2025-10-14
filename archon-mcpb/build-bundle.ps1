# Archon MCP Proxy Bundle Builder (PowerShell)
# Packages the lightweight proxy for easy Claude Desktop installation

$ErrorActionPreference = "Stop"

Write-Host "==================================" -ForegroundColor Cyan
Write-Host "Archon MCP Proxy Bundle Builder" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan
Write-Host ""

# Check if we're in the right directory
if (-not (Test-Path "manifest.json")) {
    Write-Host "Error: Run this script from the archon-mcpb directory" -ForegroundColor Red
    Write-Host "Usage: cd archon-mcpb; .\build-bundle.ps1" -ForegroundColor Yellow
    exit 1
}

# Check if MCPB CLI is installed
$mcpbInstalled = Get-Command mcpb -ErrorAction SilentlyContinue
if (-not $mcpbInstalled) {
    Write-Host "Error: MCPB CLI not found" -ForegroundColor Red
    Write-Host "Install with: npm install -g @anthropic-ai/mcpb" -ForegroundColor Yellow
    exit 1
}

Write-Host "✓ MCPB CLI found" -ForegroundColor Green
Write-Host ""

# Step 1: Validate proxy files exist
Write-Host "Step 1: Validating proxy files..." -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path "server\proxy.py")) {
    Write-Host "  ✗ Missing: server\proxy.py" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ proxy.py found" -ForegroundColor Green

if (-not (Test-Path "server\requirements.txt")) {
    Write-Host "  ✗ Missing: server\requirements.txt" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ requirements.txt found" -ForegroundColor Green

Write-Host ""
Write-Host "Step 2: Checking for icon..." -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path "icon.png")) {
    Write-Host "  ⚠ Warning: icon.png not found" -ForegroundColor Yellow
    Write-Host "    Bundle will be created without an icon" -ForegroundColor Yellow
    Write-Host "    See ICON_PLACEHOLDER.txt to add one" -ForegroundColor Yellow
} else {
    Write-Host "  ✓ icon.png found" -ForegroundColor Green
}

Write-Host ""
Write-Host "Step 3: Packaging proxy bundle..." -ForegroundColor Cyan
Write-Host ""

# Package the bundle
mcpb pack

# Rename to simple name (MCPB uses directory name for output)
if (Test-Path "archon-mcpb.mcpb") {
    Move-Item -Force "archon-mcpb.mcpb" "archon.mcpb"
}

# Check if bundle was created
if (Test-Path "archon.mcpb") {
    $bundleSize = (Get-Item "archon.mcpb").Length / 1KB
    $bundleSizeFormatted = "{0:N1} KB" -f $bundleSize

    Write-Host ""
    Write-Host "==================================" -ForegroundColor Green
    Write-Host "✓ Proxy bundle created!" -ForegroundColor Green
    Write-Host "==================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "File: archon.mcpb" -ForegroundColor White
    Write-Host "Size: $bundleSizeFormatted" -ForegroundColor White
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "1. Ensure Archon is running: docker compose up -d" -ForegroundColor White
    Write-Host "2. Install archon.mcpb in Claude Desktop" -ForegroundColor White
    Write-Host "3. Proxy will validate connection and forward requests" -ForegroundColor White
    Write-Host ""
    Write-Host "Test connection first: python check-archon.py" -ForegroundColor Yellow
    Write-Host ""
} else {
    Write-Host "Error: Bundle packaging failed" -ForegroundColor Red
    exit 1
}
