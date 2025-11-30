#!/bin/bash
# Archon Development Environment Setup (Linux/Mac)
# Usage: ./scripts/setup-dev.sh

set -e

echo "🔧 Setting up Archon development environment..."

# Check Python version
PYTHON_VERSION=$(python3 --version 2>&1 | cut -d' ' -f2 | cut -d'.' -f1,2)
if [[ $(echo "$PYTHON_VERSION < 3.10" | bc -l) -eq 1 ]]; then
    echo "❌ Python 3.10+ required. Found: $PYTHON_VERSION"
    exit 1
fi

# Create virtual environment
if [ -d "venv" ]; then
    echo "⚠️  venv/ already exists. Removing..."
    rm -rf venv
fi

echo "📦 Creating virtual environment..."
python3 -m venv venv

echo "🔄 Activating virtual environment..."
source venv/bin/activate

echo "⬆️  Upgrading pip..."
pip install --upgrade pip

echo "📥 Installing development dependencies..."
pip install -r requirements-dev.txt

echo ""
echo "✅ Development environment ready!"
echo ""
echo "To activate the environment, run:"
echo "  source venv/bin/activate"
echo ""
echo "To deactivate:"
echo "  deactivate"
