#!/bin/bash
# Archon Staging Environment Setup (Linux/Mac)
# For testing PostgreSQL backend locally without Docker
# Usage: ./scripts/setup-staging.sh

set -e

echo "🔧 Setting up Archon staging environment..."

# Check Python version
PYTHON_VERSION=$(python3 --version 2>&1 | cut -d' ' -f2 | cut -d'.' -f1,2)
if [[ $(echo "$PYTHON_VERSION < 3.10" | bc -l) -eq 1 ]]; then
    echo "❌ Python 3.10+ required. Found: $PYTHON_VERSION"
    exit 1
fi

# Create staging virtual environment
VENV_DIR="venv-staging"
if [ -d "$VENV_DIR" ]; then
    echo "⚠️  $VENV_DIR/ already exists. Removing..."
    rm -rf "$VENV_DIR"
fi

echo "📦 Creating staging virtual environment..."
python3 -m venv "$VENV_DIR"

echo "🔄 Activating virtual environment..."
source "$VENV_DIR/bin/activate"

echo "⬆️  Upgrading pip..."
pip install --upgrade pip

echo "📥 Installing staging dependencies..."
pip install -r requirements-staging.txt

echo ""
echo "✅ Staging environment ready!"
echo ""
echo "To activate the environment, run:"
echo "  source $VENV_DIR/bin/activate"
echo ""
echo "Don't forget to set PostgreSQL environment variables:"
echo "  export POSTGRES_HOST=localhost"
echo "  export POSTGRES_PORT=5432"
echo "  export POSTGRES_DB=archon_staging"
echo "  export POSTGRES_USER=postgres"
echo "  export POSTGRES_PASSWORD=your_password"
