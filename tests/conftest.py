# tests/conftest.py
"""
Fixtures globales pour les tests Archon.

Ce fichier configure:
- Les markers pytest (integration, unit, slow)
- Les configurations d'environnement de test
- Les fixtures partagees entre tous les tests

Bloc Manifest: P0-01, P0-02
"""

import pytest
import os
from pathlib import Path
from dotenv import load_dotenv

# Charger les variables d'environnement
env_path = Path(__file__).parent.parent / ".env"
load_dotenv(env_path)


def pytest_configure(config):
    """Configuration globale pytest."""
    config.addinivalue_line("markers", "integration: Tests Supabase Cloud")
    config.addinivalue_line("markers", "unit: Tests PostgreSQL local")
    config.addinivalue_line("markers", "slow: Tests longs")


@pytest.fixture(scope="session")
def test_config():
    """
    Configuration des environnements de test.

    Returns:
        dict: Configuration pour Supabase Cloud et PostgreSQL local
    """
    return {
        "supabase": {
            "url": os.getenv("SUPABASE_URL"),
            "key": os.getenv("SUPABASE_SERVICE_KEY"),
        },
        "postgres_local": {
            "host": os.getenv("POSTGRES_TEST_HOST", "localhost"),
            "port": int(os.getenv("POSTGRES_TEST_PORT", "5432")),
            "user": os.getenv("POSTGRES_TEST_USER", "postgres"),
            "password": os.getenv("POSTGRES_TEST_PASSWORD", "postgres"),
            "database": os.getenv("POSTGRES_TEST_DB", "archon_test"),
        },
        "openai": {
            "api_key": os.getenv("OPENAI_API_KEY"),
        }
    }


@pytest.fixture(scope="session")
def project_root():
    """Retourne le chemin racine du projet."""
    return Path(__file__).parent.parent


@pytest.fixture(scope="session")
def fixtures_path():
    """Retourne le chemin vers le dossier fixtures."""
    return Path(__file__).parent / "fixtures"
