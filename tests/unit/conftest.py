# tests/unit/conftest.py
"""
Fixtures pour les tests unitaires PostgreSQL local.

Ces fixtures fournissent:
- Connexion PostgreSQL locale (archon_test)
- Helpers pour le setup/teardown des donnees
- Mocks pour les services externes

Bloc Manifest: P0-02
"""

import pytest
import os
from dotenv import load_dotenv

load_dotenv()


@pytest.fixture(scope="session")
def postgres_connection(test_config):
    """
    Fixture pour la connexion PostgreSQL locale.

    Utilise la base archon_test sur le container Docker mg_postgres.

    Args:
        test_config: Configuration globale des tests

    Returns:
        Connection: Connexion psycopg2

    Raises:
        pytest.skip: Si PostgreSQL n'est pas accessible
    """
    try:
        import psycopg2
    except ImportError:
        pytest.skip("Package psycopg2 non installe")

    config = test_config["postgres_local"]

    try:
        conn = psycopg2.connect(
            host=config["host"],
            port=config["port"],
            user=config["user"],
            password=config["password"],
            database=config["database"]
        )
        yield conn
        conn.close()
    except psycopg2.OperationalError as e:
        pytest.skip(f"PostgreSQL non accessible: {e}")


@pytest.fixture(scope="session")
def postgres_cursor(postgres_connection):
    """
    Fixture pour un cursor PostgreSQL.

    Args:
        postgres_connection: Connexion PostgreSQL

    Returns:
        Cursor: Cursor pour executer des requetes
    """
    cursor = postgres_connection.cursor()
    yield cursor
    cursor.close()


@pytest.fixture(scope="function")
def clean_test_table(postgres_connection, postgres_cursor):
    """
    Fixture qui nettoie la table site_pages avant et apres chaque test.

    Utilise un filtre sur metadata->>source pour ne supprimer
    que les donnees de test.

    Yields:
        None
    """
    # Nettoyage avant le test
    postgres_cursor.execute(
        "DELETE FROM site_pages WHERE metadata->>'source' = 'test_unit'"
    )
    postgres_connection.commit()

    yield

    # Nettoyage apres le test
    postgres_cursor.execute(
        "DELETE FROM site_pages WHERE metadata->>'source' = 'test_unit'"
    )
    postgres_connection.commit()


@pytest.fixture(scope="function")
def sample_site_page():
    """
    Fixture retournant un exemple de donnees site_page.

    Returns:
        dict: Donnees de test pour une page
    """
    return {
        "url": "https://test.example.com/doc",
        "chunk_number": 1,
        "title": "Test Document",
        "summary": "This is a test document for unit tests",
        "content": "Full content of the test document goes here.",
        "metadata": {
            "source": "test_unit",
            "chunk_size": 1000,
            "crawled_at": "2025-01-01T00:00:00Z"
        }
    }


@pytest.fixture(scope="session")
def sample_embedding():
    """
    Fixture retournant un embedding de test (vecteur 1536 dimensions).

    Returns:
        list: Vecteur de 1536 floats (valeurs normalisees)
    """
    import random
    random.seed(42)  # Reproductibilite
    # Generer un vecteur normalise
    embedding = [random.gauss(0, 1) for _ in range(1536)]
    # Normaliser
    norm = sum(x**2 for x in embedding) ** 0.5
    return [x / norm for x in embedding]
