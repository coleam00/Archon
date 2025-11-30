# tests/integration/conftest.py
"""
Fixtures pour les tests d'integration Supabase Cloud.

Ces fixtures fournissent:
- Client Supabase configure
- Client OpenAI pour les embeddings
- Helpers pour l'isolation des donnees de test

Bloc Manifest: P0-02
"""

import pytest
import os
from dotenv import load_dotenv

load_dotenv()


@pytest.fixture(scope="session")
def supabase_client(test_config):
    """
    Fixture pour le client Supabase de test (production).

    Utilise les credentials de production avec isolation
    par metadata source='test_characterization'.

    Args:
        test_config: Configuration globale des tests

    Returns:
        Client: Instance du client Supabase

    Raises:
        pytest.skip: Si les credentials ne sont pas configurees
    """
    try:
        from supabase import create_client, Client
    except ImportError:
        pytest.skip("Package supabase non installe")

    url = test_config["supabase"]["url"]
    key = test_config["supabase"]["key"]

    if not url or not key:
        pytest.skip("Supabase credentials non configurees (SUPABASE_URL, SUPABASE_SERVICE_KEY)")

    return create_client(url, key)


@pytest.fixture(scope="session")
def embedding_client(test_config):
    """
    Fixture pour le client OpenAI embeddings.

    Args:
        test_config: Configuration globale des tests

    Returns:
        AsyncOpenAI: Instance du client OpenAI async

    Raises:
        pytest.skip: Si l'API key n'est pas configuree
    """
    try:
        from openai import AsyncOpenAI
    except ImportError:
        pytest.skip("Package openai non installe")

    api_key = test_config["openai"]["api_key"]

    if not api_key:
        pytest.skip("OpenAI API key non configuree (OPENAI_API_KEY)")

    return AsyncOpenAI(api_key=api_key)


@pytest.fixture(scope="function")
def test_source_filter():
    """
    Retourne le filtre pour isoler les donnees de test.

    Utilise pour marquer et filtrer les donnees creees
    pendant les tests de caracterisation.

    Returns:
        dict: Filtre metadata pour l'isolation
    """
    return {"source": "test_characterization"}


@pytest.fixture(scope="function")
async def cleanup_test_data(supabase_client, test_source_filter):
    """
    Fixture de nettoyage des donnees de test.

    S'execute automatiquement apres chaque test pour
    supprimer les donnees creees avec source='test_characterization'.

    Yields:
        None

    Note:
        Cette fixture utilise yield pour s'executer APRES le test
    """
    yield

    # Nettoyage apres le test
    try:
        supabase_client.table("site_pages").delete().eq(
            "metadata->>source", test_source_filter["source"]
        ).execute()
    except Exception as e:
        # Log mais ne pas faire echouer le test
        print(f"Warning: Cleanup failed: {e}")
