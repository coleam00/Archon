# Archon Development Environment Setup (Windows PowerShell)
# Usage: .\scripts\setup-dev.ps1

$ErrorActionPreference = "Stop"

Write-Host "🔧 Setting up Archon development environment..." -ForegroundColor Cyan

# Check Python version
$pythonVersion = python --version 2>&1
if ($pythonVersion -match "Python (\d+)\.(\d+)") {
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    if ($major -lt 3 -or ($major -eq 3 -and $minor -lt 10)) {
        Write-Host "❌ Python 3.10+ required. Found: $pythonVersion" -ForegroundColor Red
        exit 1
    }
}

# Create virtual environment
if (Test-Path "venv") {
    Write-Host "⚠️  venv/ already exists. Removing..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force "venv"
}

Write-Host "📦 Creating virtual environment..." -ForegroundColor Green
python -m venv venv

Write-Host "🔄 Activating virtual environment..." -ForegroundColor Green
& .\venv\Scripts\Activate.ps1

Write-Host "⬆️  Upgrading pip..." -ForegroundColor Green
pip install --upgrade pip

Write-Host "📥 Installing development dependencies..." -ForegroundColor Green
pip install -r requirements-dev.txt

Write-Host ""
Write-Host "✅ Development environment ready!" -ForegroundColor Green
Write-Host ""
Write-Host "To activate the environment, run:" -ForegroundColor Cyan
Write-Host "  .\venv\Scripts\Activate.ps1"
Write-Host ""
Write-Host "To deactivate:" -ForegroundColor Cyan
Write-Host "  deactivate"
