# Archon Staging Environment Setup (Windows PowerShell)
# For testing PostgreSQL backend locally without Docker
# Usage: .\scripts\setup-staging.ps1

$ErrorActionPreference = "Stop"

Write-Host "🔧 Setting up Archon staging environment..." -ForegroundColor Cyan

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

$VenvDir = "venv-staging"

# Create staging virtual environment
if (Test-Path $VenvDir) {
    Write-Host "⚠️  $VenvDir/ already exists. Removing..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $VenvDir
}

Write-Host "📦 Creating staging virtual environment..." -ForegroundColor Green
python -m venv $VenvDir

Write-Host "🔄 Activating virtual environment..." -ForegroundColor Green
& .\$VenvDir\Scripts\Activate.ps1

Write-Host "⬆️  Upgrading pip..." -ForegroundColor Green
pip install --upgrade pip

Write-Host "📥 Installing staging dependencies..." -ForegroundColor Green
pip install -r requirements-staging.txt

Write-Host ""
Write-Host "✅ Staging environment ready!" -ForegroundColor Green
Write-Host ""
Write-Host "To activate the environment, run:" -ForegroundColor Cyan
Write-Host "  .\$VenvDir\Scripts\Activate.ps1"
Write-Host ""
Write-Host "Don't forget to set PostgreSQL environment variables:" -ForegroundColor Yellow
Write-Host '  $env:POSTGRES_HOST = "localhost"'
Write-Host '  $env:POSTGRES_PORT = "5432"'
Write-Host '  $env:POSTGRES_DB = "archon_staging"'
Write-Host '  $env:POSTGRES_USER = "postgres"'
Write-Host '  $env:POSTGRES_PASSWORD = "your_password"'
