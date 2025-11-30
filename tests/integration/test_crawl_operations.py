# tests/integration/test_crawl_operations.py
"""
Tests de caracterisation pour les operations CRUD de crawl_pydantic_ai_docs.py

Ces tests capturent le comportement ACTUEL des operations de base de donnees
avant refactorisation. Ils utilisent l'isolation par source='test_characterization'.

Blocs Manifest: P3-04a, P3-04b, P3-04c
- P3-04b: supabase.table().insert() (ligne 261)
- P3-04c: supabase.table().delete() (ligne 426)

Fonctions testees:
- insert_chunk (lignes 248-266)
- clear_existing_records (lignes 423-431)

Usage:
    pytest tests/integration/test_crawl_operations.py -v -m integration

Prerequis:
    pip install supabase openai html2text crawl4ai pytest-asyncio
"""

import pytest
import sys
import os
from datetime import datetime, timezone
from typing import List, Dict, Any
from dataclasses import dataclass

# Ajouter le chemin parent pour les imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# Imports conditionnels - skip si les dependances ne sont pas installees
pytest.importorskip("supabase", reason="Package supabase requis pour les tests d'integration")


# Definition locale de ProcessedChunk pour eviter les imports avec dependances lourdes
# Cette definition DOIT correspondre exactement a celle de crawl_pydantic_ai_docs.py
@dataclass
class ProcessedChunk:
    """
    Structure de donnees pour un chunk traite.

    Copie locale de la definition dans crawl_pydantic_ai_docs.py (lignes 54-62)
    pour eviter d'importer les dependances lourdes (crawl4ai, html2text).
    """
    url: str
    chunk_number: int
    title: str
    summary: str
    content: str
    metadata: Dict[str, Any]
    embedding: List[float]


# =============================================================================
# Helpers pour les tests
# =============================================================================

def create_test_chunk(
    url: str = "https://test.example.com/doc",
    chunk_number: int = 0,
    title: str = "Test Document",
    summary: str = "Test summary",
    content: str = "Test content for characterization tests.",
    source: str = "test_characterization"
) -> Dict[str, Any]:
    """
    Cree un chunk de test avec les donnees specifiees.

    Args:
        url: URL du document
        chunk_number: Numero du chunk
        title: Titre du document
        summary: Resume du document
        content: Contenu du document
        source: Source pour l'isolation des donnees de test

    Returns:
        dict: Donnees du chunk pret pour insertion
    """
    # Generer un embedding factice (vecteur zero pour les tests)
    # Note: En production, cet embedding serait genere par OpenAI
    embedding = [0.0] * 1536

    return {
        "url": url,
        "chunk_number": chunk_number,
        "title": title,
        "summary": summary,
        "content": content,
        "metadata": {
            "source": source,
            "chunk_size": len(content),
            "crawled_at": datetime.now(timezone.utc).isoformat(),
            "url_path": "/test"
        },
        "embedding": embedding
    }


# =============================================================================
# Tests pour INSERT operations
# Bloc Manifest: P3-04b
# Lignes: 261 (insert_chunk)
# =============================================================================

@pytest.mark.integration
class TestInsertOperations:
    """
    Tests de caracterisation pour les operations INSERT.

    Comportement actuel (ligne 261):
    - supabase.table("site_pages").insert(data).execute()

    Ces tests verifient:
    - L'insertion simple fonctionne
    - Les donnees inserees sont recuperables
    - Les contraintes (url, chunk_number) sont respectees
    """

    @pytest.mark.asyncio
    async def test_insert_single_chunk(self, supabase_client, cleanup_test_data):
        """
        CARACTERISATION: Insertion d'un seul chunk.

        Comportement actuel:
        - L'insertion retourne un resultat avec les donnees inserees
        - Le chunk est recuperable apres insertion
        """
        chunk_data = create_test_chunk(
            url="https://test.characterization.com/single",
            chunk_number=0
        )

        # Insert
        result = supabase_client.table("site_pages").insert(chunk_data).execute()

        assert result.data is not None, (
            "Comportement change: l'insertion devrait retourner des donnees."
        )
        assert len(result.data) == 1, (
            "Comportement change: une insertion devrait retourner exactement 1 element."
        )

        # Verifier que les donnees sont correctes
        inserted = result.data[0]
        assert inserted["url"] == chunk_data["url"]
        assert inserted["chunk_number"] == chunk_data["chunk_number"]
        assert inserted["title"] == chunk_data["title"]

    @pytest.mark.asyncio
    async def test_insert_multiple_chunks_same_url(self, supabase_client, cleanup_test_data):
        """
        CARACTERISATION: Insertion de plusieurs chunks pour la meme URL.

        Comportement actuel:
        - Chaque chunk a un chunk_number different
        - Tous les chunks sont inserables pour la meme URL
        """
        base_url = "https://test.characterization.com/multiple"
        chunks = []

        for i in range(3):
            chunk_data = create_test_chunk(
                url=base_url,
                chunk_number=i,
                title=f"Test Document - Chunk {i}",
                content=f"Content for chunk {i}"
            )
            chunks.append(chunk_data)

        # Insert tous les chunks
        for chunk_data in chunks:
            result = supabase_client.table("site_pages").insert(chunk_data).execute()
            assert result.data is not None

        # Verifier le nombre de chunks inseres
        verify_result = supabase_client.from_("site_pages") \
            .select("*") \
            .eq("url", base_url) \
            .execute()

        assert len(verify_result.data) == 3, (
            f"Comportement change: 3 chunks attendus, {len(verify_result.data)} trouves."
        )

    @pytest.mark.asyncio
    async def test_insert_batch(self, supabase_client, cleanup_test_data):
        """
        CARACTERISATION: Insertion par batch (liste de chunks).

        Comportement actuel:
        - Supabase accepte une liste pour insertion batch
        - Tous les elements sont inseres en une seule operation
        """
        base_url = "https://test.characterization.com/batch"
        chunks = [
            create_test_chunk(url=base_url, chunk_number=i, title=f"Batch {i}")
            for i in range(5)
        ]

        # Insert batch
        result = supabase_client.table("site_pages").insert(chunks).execute()

        assert result.data is not None, (
            "Comportement change: l'insertion batch devrait retourner des donnees."
        )
        assert len(result.data) == 5, (
            f"Comportement change: 5 elements attendus, {len(result.data)} retournes."
        )

    @pytest.mark.asyncio
    async def test_insert_duplicate_constraint_error(self, supabase_client, cleanup_test_data):
        """
        CARACTERISATION: Violation de contrainte UNIQUE(url, chunk_number).

        Comportement actuel:
        - Inserting un doublon leve une exception
        - La contrainte UNIQUE est respectee
        """
        chunk_data = create_test_chunk(
            url="https://test.characterization.com/duplicate",
            chunk_number=0
        )

        # Premier insert - OK
        result1 = supabase_client.table("site_pages").insert(chunk_data).execute()
        assert result1.data is not None

        # Deuxieme insert - Devrait echouer (meme url + chunk_number)
        try:
            result2 = supabase_client.table("site_pages").insert(chunk_data).execute()
            # Si on arrive ici sans exception, verifier qu'une erreur est signalee
            pytest.fail(
                "Comportement change: l'insertion d'un doublon devrait lever une exception."
            )
        except Exception as e:
            # C'est le comportement attendu
            assert "duplicate" in str(e).lower() or "unique" in str(e).lower(), (
                f"Exception inattendue: {e}"
            )

    @pytest.mark.asyncio
    async def test_insert_with_embedding_vector(self, supabase_client, cleanup_test_data):
        """
        CARACTERISATION: Insertion avec un vecteur embedding.

        Comportement actuel:
        - Le vecteur embedding est stocke correctement
        - pgvector gere le type VECTOR(1536)
        """
        # Creer un embedding non-zero pour verifier le stockage
        embedding = [0.1] * 1536

        chunk_data = create_test_chunk(
            url="https://test.characterization.com/embedding",
            chunk_number=0
        )
        chunk_data["embedding"] = embedding

        result = supabase_client.table("site_pages").insert(chunk_data).execute()

        assert result.data is not None

        # Note: Supabase peut ne pas retourner l'embedding dans la reponse
        # selon la configuration. On verifie juste que l'insertion fonctionne.


# =============================================================================
# Tests pour DELETE operations
# Bloc Manifest: P3-04c
# Lignes: 426 (clear_existing_records)
# =============================================================================

@pytest.mark.integration
class TestDeleteOperations:
    """
    Tests de caracterisation pour les operations DELETE.

    Comportement actuel (ligne 426):
    - supabase.table("site_pages").delete().eq("metadata->>source", "pydantic_ai_docs").execute()

    Ces tests verifient:
    - La suppression par source fonctionne
    - La suppression est complete (pas de residus)
    - Les autres sources ne sont pas affectees
    """

    @pytest.mark.asyncio
    async def test_delete_by_source(self, supabase_client):
        """
        CARACTERISATION: Suppression par metadata->>source.

        Comportement actuel:
        - supabase.table().delete().eq("metadata->>source", source).execute()
        - Supprime tous les enregistrements avec la source specifiee
        """
        source = "test_characterization_delete"

        # Setup: Inserer des donnees de test
        chunks = [
            create_test_chunk(
                url=f"https://test.delete.com/page{i}",
                chunk_number=0,
                source=source
            )
            for i in range(3)
        ]

        for chunk in chunks:
            supabase_client.table("site_pages").insert(chunk).execute()

        # Verifier que les donnees sont inserees
        before = supabase_client.from_("site_pages") \
            .select("id") \
            .eq("metadata->>source", source) \
            .execute()

        assert len(before.data) == 3, "Setup: 3 enregistrements attendus"

        # Delete par source
        delete_result = supabase_client.table("site_pages") \
            .delete() \
            .eq("metadata->>source", source) \
            .execute()

        # Verifier la suppression
        after = supabase_client.from_("site_pages") \
            .select("id") \
            .eq("metadata->>source", source) \
            .execute()

        assert len(after.data) == 0, (
            f"Comportement change: tous les enregistrements devraient etre supprimes, "
            f"{len(after.data)} restent."
        )

    @pytest.mark.asyncio
    async def test_delete_does_not_affect_other_sources(self, supabase_client, cleanup_test_data):
        """
        CARACTERISATION: La suppression par source n'affecte pas les autres sources.

        Comportement actuel:
        - Le filtre eq("metadata->>source", X) est specifique
        - Les enregistrements avec d'autres sources restent intacts
        """
        source_to_delete = "test_to_delete"
        source_to_keep = "test_characterization"  # Sera nettoye par cleanup_test_data

        # Setup: Inserer des donnees avec deux sources differentes
        chunk_delete = create_test_chunk(
            url="https://test.isolation.com/delete",
            source=source_to_delete
        )
        chunk_keep = create_test_chunk(
            url="https://test.isolation.com/keep",
            source=source_to_keep
        )

        supabase_client.table("site_pages").insert(chunk_delete).execute()
        supabase_client.table("site_pages").insert(chunk_keep).execute()

        # Delete seulement source_to_delete
        supabase_client.table("site_pages") \
            .delete() \
            .eq("metadata->>source", source_to_delete) \
            .execute()

        # Verifier que source_to_keep est toujours la
        remaining = supabase_client.from_("site_pages") \
            .select("*") \
            .eq("metadata->>source", source_to_keep) \
            .eq("url", "https://test.isolation.com/keep") \
            .execute()

        assert len(remaining.data) == 1, (
            "Comportement change: les enregistrements d'autres sources "
            "ne devraient pas etre supprimes."
        )

    @pytest.mark.asyncio
    async def test_delete_nonexistent_source(self, supabase_client):
        """
        CARACTERISATION: Suppression d'une source inexistante ne leve pas d'erreur.

        Comportement actuel:
        - La requete DELETE s'execute sans erreur
        - Aucun enregistrement n'est affecte
        """
        nonexistent_source = "nonexistent_source_xyz123"

        # Ceci ne devrait pas lever d'exception
        result = supabase_client.table("site_pages") \
            .delete() \
            .eq("metadata->>source", nonexistent_source) \
            .execute()

        # Verifier que la requete s'est executee sans erreur
        assert result is not None


# =============================================================================
# Tests pour SELECT operations
# Blocs Manifest: P2-02a, P2-02b, P2-02c (indirectement)
# =============================================================================

@pytest.mark.integration
class TestSelectOperations:
    """
    Tests de caracterisation pour les operations SELECT.

    Ces tests capturent le comportement des requetes de lecture
    qui seront encapsulees dans le Repository.
    """

    @pytest.mark.asyncio
    async def test_select_with_source_filter(self, supabase_client, cleanup_test_data):
        """
        CARACTERISATION: SELECT avec filtre sur metadata->>source.

        Comportement utilise dans:
        - list_documentation_pages_tool (ligne 72)
        - get_page_content_tool (ligne 102)
        """
        source = "test_characterization"

        # Setup: Inserer une donnee de test
        chunk = create_test_chunk(source=source)
        supabase_client.table("site_pages").insert(chunk).execute()

        # Select avec filtre source
        result = supabase_client.from_("site_pages") \
            .select("url, title") \
            .eq("metadata->>source", source) \
            .execute()

        assert result.data is not None
        assert len(result.data) >= 1

        # Verifier la structure des donnees retournees
        first_item = result.data[0]
        assert "url" in first_item
        assert "title" in first_item

    @pytest.mark.asyncio
    async def test_select_with_url_filter(self, supabase_client, cleanup_test_data):
        """
        CARACTERISATION: SELECT avec filtre sur url.

        Comportement utilise dans:
        - get_page_content_tool (ligne 101)
        """
        test_url = "https://test.characterization.com/select-url"

        # Setup: Inserer une donnee de test
        chunk = create_test_chunk(url=test_url)
        supabase_client.table("site_pages").insert(chunk).execute()

        # Select avec filtre url
        result = supabase_client.from_("site_pages") \
            .select("*") \
            .eq("url", test_url) \
            .execute()

        assert result.data is not None
        assert len(result.data) == 1
        assert result.data[0]["url"] == test_url

    @pytest.mark.asyncio
    async def test_select_ordered_by_chunk_number(self, supabase_client, cleanup_test_data):
        """
        CARACTERISATION: SELECT avec ORDER BY chunk_number.

        Comportement utilise dans:
        - get_page_content_tool (ligne 103)
        """
        test_url = "https://test.characterization.com/ordered"

        # Setup: Inserer des chunks dans le desordre
        for i in [2, 0, 1]:
            chunk = create_test_chunk(
                url=test_url,
                chunk_number=i,
                content=f"Chunk {i}"
            )
            supabase_client.table("site_pages").insert(chunk).execute()

        # Select avec ORDER BY
        result = supabase_client.from_("site_pages") \
            .select("chunk_number, content") \
            .eq("url", test_url) \
            .order("chunk_number") \
            .execute()

        assert len(result.data) == 3

        # Verifier l'ordre
        chunk_numbers = [item["chunk_number"] for item in result.data]
        assert chunk_numbers == [0, 1, 2], (
            f"Comportement change: les chunks devraient etre ordonnes. "
            f"Ordre actuel: {chunk_numbers}"
        )


# =============================================================================
# Tests pour RPC operations (match_site_pages)
# Bloc Manifest: P2-02a, P3-03c
# =============================================================================

@pytest.mark.integration
class TestRpcOperations:
    """
    Tests de caracterisation pour les appels RPC.

    Comportement actuel (lignes 30-37 de agent_tools.py):
    - supabase.rpc('match_site_pages', {...}).execute()

    La fonction match_site_pages:
    - Prend query_embedding, match_count, filter
    - Retourne les pages les plus similaires
    """

    @pytest.mark.asyncio
    async def test_rpc_match_site_pages_structure(self, supabase_client, cleanup_test_data):
        """
        CARACTERISATION: Structure de l'appel RPC match_site_pages.

        Comportement actuel:
        - Accepte query_embedding (list[float]), match_count (int), filter (dict)
        - Retourne une liste de resultats avec similarity score
        """
        # Setup: Inserer une donnee de test avec un embedding non-zero
        embedding = [0.1] * 1536
        chunk = create_test_chunk(
            url="https://test.rpc.com/match",
            source="test_characterization"
        )
        chunk["embedding"] = embedding
        supabase_client.table("site_pages").insert(chunk).execute()

        # Appel RPC
        result = supabase_client.rpc(
            'match_site_pages',
            {
                'query_embedding': embedding,
                'match_count': 5,
                'filter': {'source': 'test_characterization'}
            }
        ).execute()

        assert result.data is not None, (
            "Comportement change: l'appel RPC devrait retourner des donnees."
        )

        # La structure peut varier selon que des resultats sont trouves
        if result.data:
            first_result = result.data[0]
            # Verifier les champs attendus
            expected_fields = ['id', 'url', 'title', 'content']
            for field in expected_fields:
                assert field in first_result, (
                    f"Comportement change: le champ '{field}' devrait etre present."
                )

    @pytest.mark.asyncio
    async def test_rpc_with_empty_filter(self, supabase_client, cleanup_test_data):
        """
        CARACTERISATION: Appel RPC sans filtre source.

        Note: Le comportement peut varier selon la fonction SQL.
        """
        embedding = [0.1] * 1536

        # Setup
        chunk = create_test_chunk()
        chunk["embedding"] = embedding
        supabase_client.table("site_pages").insert(chunk).execute()

        # Appel RPC avec filtre vide
        result = supabase_client.rpc(
            'match_site_pages',
            {
                'query_embedding': embedding,
                'match_count': 5,
                'filter': {}
            }
        ).execute()

        # Devrait s'executer sans erreur
        assert result is not None


# =============================================================================
# Tests de structure ProcessedChunk
# =============================================================================

@pytest.mark.integration
class TestProcessedChunkStructure:
    """
    Tests de caracterisation pour la dataclass ProcessedChunk.

    Cette structure est utilisee pour stocker les chunks traites
    avant insertion dans Supabase.
    """

    def test_processed_chunk_fields(self):
        """
        CARACTERISATION: Structure de ProcessedChunk.

        Champs attendus:
        - url: str
        - chunk_number: int
        - title: str
        - summary: str
        - content: str
        - metadata: Dict[str, Any]
        - embedding: List[float]
        """
        chunk = ProcessedChunk(
            url="https://test.com",
            chunk_number=0,
            title="Test",
            summary="Summary",
            content="Content",
            metadata={"source": "test"},
            embedding=[0.0] * 1536
        )

        assert chunk.url == "https://test.com"
        assert chunk.chunk_number == 0
        assert chunk.title == "Test"
        assert chunk.summary == "Summary"
        assert chunk.content == "Content"
        assert chunk.metadata == {"source": "test"}
        assert len(chunk.embedding) == 1536

    def test_processed_chunk_to_dict(self):
        """
        CARACTERISATION: Conversion ProcessedChunk vers dict pour insertion.

        Le format dict est utilise par insert_chunk (ligne 251-259).
        """
        chunk = ProcessedChunk(
            url="https://test.com",
            chunk_number=0,
            title="Test",
            summary="Summary",
            content="Content",
            metadata={"source": "test"},
            embedding=[0.0] * 1536
        )

        # Conversion manuelle (comme dans insert_chunk)
        data = {
            "url": chunk.url,
            "chunk_number": chunk.chunk_number,
            "title": chunk.title,
            "summary": chunk.summary,
            "content": chunk.content,
            "metadata": chunk.metadata,
            "embedding": chunk.embedding
        }

        # Verifier que tous les champs sont presents
        required_fields = ["url", "chunk_number", "title", "summary", "content", "metadata", "embedding"]
        for field in required_fields:
            assert field in data, f"Champ manquant: {field}"
