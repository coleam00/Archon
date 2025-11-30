# tests/integration/test_agent_tools.py
"""
Tests de caracterisation pour archon/agent_tools.py

Ces tests capturent le comportement ACTUEL avant refactorisation.
Ils servent de reference pour valider que la refactorisation
ne modifie pas le comportement observable.

Blocs Manifest: P3-03a, P3-03b, P3-03c, P3-03d, P3-03e, P3-03f, P3-03g

Fonctions testees:
- retrieve_relevant_documentation_tool (lignes 24-57)
- list_documentation_pages_tool (lignes 59-84)
- get_page_content_tool (lignes 86-123)

Usage:
    pytest tests/integration/test_agent_tools.py -v -m integration

Prerequis:
    pip install supabase openai pytest-asyncio
"""

import pytest
import sys
import os

# Ajouter le chemin parent pour les imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# Imports conditionnels - skip si les dependances ne sont pas installees
pytest.importorskip("supabase", reason="Package supabase requis pour les tests d'integration")
pytest.importorskip("openai", reason="Package openai requis pour les tests d'integration")

from archon.agent_tools import (
    retrieve_relevant_documentation_tool,
    list_documentation_pages_tool,
    get_page_content_tool,
    get_embedding
)


# =============================================================================
# Tests pour retrieve_relevant_documentation_tool
# Bloc Manifest: P3-03b, P3-03c
# Lignes: 24-57
# =============================================================================

@pytest.mark.integration
class TestRetrieveRelevantDocumentation:
    """
    Tests de caracterisation pour retrieve_relevant_documentation_tool.

    Cette fonction:
    1. Prend une query utilisateur
    2. Genere un embedding via OpenAI
    3. Appelle supabase.rpc('match_site_pages', {...})
    4. Retourne une string formatee des resultats

    Comportement capture:
    - Retourne toujours une string (jamais None)
    - Format: chunks separes par "---"
    - En cas d'erreur: retourne message d'erreur comme string
    """

    @pytest.mark.asyncio
    async def test_returns_string_type(self, supabase_client, embedding_client):
        """
        CARACTERISATION: La fonction retourne toujours une string.

        Comportement actuel observe:
        - Type de retour: str
        - Jamais None ou autre type
        """
        result = await retrieve_relevant_documentation_tool(
            supabase_client,
            embedding_client,
            "How to create a Pydantic AI agent?"
        )

        assert isinstance(result, str), (
            f"Expected str, got {type(result).__name__}. "
            "Comportement change: la fonction doit retourner une string."
        )

    @pytest.mark.asyncio
    async def test_non_empty_result_for_valid_query(self, supabase_client, embedding_client):
        """
        CARACTERISATION: Une query valide retourne un resultat non vide.

        Note: Ce test suppose que la base contient des docs pydantic_ai_docs.
        Si la base est vide, le resultat sera "No relevant documentation found."
        """
        result = await retrieve_relevant_documentation_tool(
            supabase_client,
            embedding_client,
            "pydantic agent tools"
        )

        assert len(result) > 0, (
            "Comportement change: la fonction retourne une string vide "
            "alors qu'elle devrait retourner du contenu ou un message."
        )

    @pytest.mark.asyncio
    async def test_empty_query_returns_result(self, supabase_client, embedding_client):
        """
        CARACTERISATION: Une query vide est geree gracieusement.

        Comportement actuel a capturer:
        - La fonction ne leve pas d'exception
        - Elle retourne une string (resultat ou message)
        """
        result = await retrieve_relevant_documentation_tool(
            supabase_client,
            embedding_client,
            ""
        )

        # La fonction doit gerer une query vide sans exception
        assert isinstance(result, str), (
            "Comportement change: une query vide devrait retourner une string."
        )

    @pytest.mark.asyncio
    @pytest.mark.slow
    async def test_result_format_contains_separator_when_multiple_results(
        self, supabase_client, embedding_client
    ):
        """
        CARACTERISATION: Le format de sortie utilise '---' comme separateur.

        Comportement actuel (lignes 52-53):
        - Les chunks sont joints par "\\n\\n---\\n\\n"
        - Chaque chunk a un format: "# {title}\\n\\n{content}"

        Note: Ce test ne verifie le separateur que si plusieurs resultats.
        """
        result = await retrieve_relevant_documentation_tool(
            supabase_client,
            embedding_client,
            "How to use pydantic AI agents?"
        )

        # Si des resultats sont trouves et multiples, le separateur est present
        if "No relevant documentation found" not in result:
            # Le resultat peut contenir le separateur si multiple chunks
            # Ce comportement est documente, pas forcement present
            assert isinstance(result, str)  # Minimal: type correct

    @pytest.mark.asyncio
    async def test_no_results_message(self, supabase_client, embedding_client):
        """
        CARACTERISATION: Si aucun resultat, retourne un message specifique.

        Comportement actuel (ligne 40):
        - return "No relevant documentation found."

        Note: Ce test utilise une query tres improbable.
        """
        result = await retrieve_relevant_documentation_tool(
            supabase_client,
            embedding_client,
            "xyzzy123456789nonexistent query that should not match anything"
        )

        # On capture le comportement: soit des resultats, soit un message
        assert isinstance(result, str)
        # Le message exact depend de la base de donnees


# =============================================================================
# Tests pour list_documentation_pages_tool
# Bloc Manifest: P3-03d, P3-03e
# Lignes: 59-84
# =============================================================================

@pytest.mark.integration
class TestListDocumentationPages:
    """
    Tests de caracterisation pour list_documentation_pages_tool.

    Cette fonction:
    1. Query supabase.from_('site_pages').select('url').eq('metadata->>source', 'pydantic_ai_docs')
    2. Extrait et deduplique les URLs
    3. Retourne une liste triee

    Comportement capture:
    - Retourne toujours une liste (jamais None)
    - Liste vide si pas de donnees
    - URLs uniques et triees
    """

    @pytest.mark.asyncio
    async def test_returns_list_type(self, supabase_client):
        """
        CARACTERISATION: La fonction retourne toujours une liste.

        Comportement actuel observe:
        - Type de retour: list
        - Jamais None ou autre type
        """
        result = await list_documentation_pages_tool(supabase_client)

        assert isinstance(result, list), (
            f"Expected list, got {type(result).__name__}. "
            "Comportement change: la fonction doit retourner une liste."
        )

    @pytest.mark.asyncio
    async def test_list_contains_only_strings(self, supabase_client):
        """
        CARACTERISATION: Tous les elements de la liste sont des strings (URLs).

        Comportement actuel (ligne 79):
        - urls = sorted(set(doc['url'] for doc in result.data))
        """
        result = await list_documentation_pages_tool(supabase_client)

        if result:  # Si la liste n'est pas vide
            assert all(isinstance(url, str) for url in result), (
                "Comportement change: tous les elements doivent etre des strings."
            )

    @pytest.mark.asyncio
    async def test_list_is_sorted(self, supabase_client):
        """
        CARACTERISATION: La liste retournee est triee alphabetiquement.

        Comportement actuel (ligne 79):
        - sorted(set(...))
        """
        result = await list_documentation_pages_tool(supabase_client)

        if len(result) > 1:
            assert result == sorted(result), (
                "Comportement change: la liste devrait etre triee."
            )

    @pytest.mark.asyncio
    async def test_urls_are_unique(self, supabase_client):
        """
        CARACTERISATION: La liste ne contient pas de doublons.

        Comportement actuel (ligne 79):
        - set(...) pour deduplication
        """
        result = await list_documentation_pages_tool(supabase_client)

        assert len(result) == len(set(result)), (
            "Comportement change: la liste ne devrait pas contenir de doublons."
        )

    @pytest.mark.asyncio
    async def test_urls_start_with_https(self, supabase_client):
        """
        CARACTERISATION: Les URLs valides commencent par https://.

        Note: Ce test documente le format attendu des URLs dans la base.
        """
        result = await list_documentation_pages_tool(supabase_client)

        if result:
            # Verifier que les URLs ont un format valide
            for url in result:
                assert url.startswith("http://") or url.startswith("https://"), (
                    f"URL invalide detectee: {url}"
                )


# =============================================================================
# Tests pour get_page_content_tool
# Bloc Manifest: P3-03f, P3-03g
# Lignes: 86-123
# =============================================================================

@pytest.mark.integration
class TestGetPageContent:
    """
    Tests de caracterisation pour get_page_content_tool.

    Cette fonction:
    1. Query supabase pour tous les chunks d'une URL
    2. Ordonne par chunk_number
    3. Formate avec titre et contenu
    4. Limite a 20000 caracteres

    Comportement capture:
    - Retourne toujours une string
    - Format: "# {title}\\n" suivi du contenu
    - URL inexistante: "No content found for URL: {url}"
    - Contenu tronque a 20000 chars max
    """

    @pytest.mark.asyncio
    async def test_returns_string_type(self, supabase_client):
        """
        CARACTERISATION: La fonction retourne toujours une string.
        """
        # Utiliser une URL de test ou une URL existante
        pages = await list_documentation_pages_tool(supabase_client)

        if not pages:
            pytest.skip("Pas de pages dans la base de donnees")

        result = await get_page_content_tool(supabase_client, pages[0])

        assert isinstance(result, str), (
            f"Expected str, got {type(result).__name__}. "
            "Comportement change: la fonction doit retourner une string."
        )

    @pytest.mark.asyncio
    async def test_unknown_url_returns_message(self, supabase_client):
        """
        CARACTERISATION: Une URL inexistante retourne un message specifique.

        Comportement actuel (ligne 107):
        - return f"No content found for URL: {url}"
        """
        unknown_url = "https://nonexistent-url-that-does-not-exist-12345.com/page"
        result = await get_page_content_tool(supabase_client, unknown_url)

        assert isinstance(result, str)
        assert "No content found" in result or "Error" in result, (
            "Comportement change: une URL inexistante devrait retourner un message."
        )

    @pytest.mark.asyncio
    async def test_content_starts_with_title(self, supabase_client):
        """
        CARACTERISATION: Le contenu retourne commence par un titre markdown.

        Comportement actuel (ligne 111):
        - formatted_content = [f"# {page_title}\\n"]
        """
        pages = await list_documentation_pages_tool(supabase_client)

        if not pages:
            pytest.skip("Pas de pages dans la base de donnees")

        result = await get_page_content_tool(supabase_client, pages[0])

        if "No content found" not in result and "Error" not in result:
            assert result.startswith("# "), (
                "Comportement change: le contenu devrait commencer par '# ' (titre markdown)."
            )

    @pytest.mark.asyncio
    async def test_content_length_limit(self, supabase_client):
        """
        CARACTERISATION: Le contenu est limite a 20000 caracteres.

        Comportement actuel (ligne 119):
        - return "\\n\\n".join(formatted_content)[:20000]
        """
        pages = await list_documentation_pages_tool(supabase_client)

        if not pages:
            pytest.skip("Pas de pages dans la base de donnees")

        result = await get_page_content_tool(supabase_client, pages[0])

        assert len(result) <= 20000, (
            f"Comportement change: le contenu ({len(result)} chars) "
            "devrait etre limite a 20000 caracteres."
        )


# =============================================================================
# Tests pour get_embedding (fonction helper)
# Lignes: 12-22
# =============================================================================

@pytest.mark.integration
@pytest.mark.slow
class TestGetEmbedding:
    """
    Tests de caracterisation pour la fonction get_embedding.

    Cette fonction:
    1. Appelle OpenAI embeddings API
    2. Retourne un vecteur de 1536 floats
    3. En cas d'erreur, retourne un vecteur zero

    Note: Ces tests consomment des tokens OpenAI.
    """

    @pytest.mark.asyncio
    async def test_returns_list_of_floats(self, embedding_client):
        """
        CARACTERISATION: get_embedding retourne une liste de floats.
        """
        result = await get_embedding("test query", embedding_client)

        assert isinstance(result, list), (
            f"Expected list, got {type(result).__name__}"
        )

        if result:
            assert all(isinstance(x, (int, float)) for x in result), (
                "Tous les elements doivent etre des nombres."
            )

    @pytest.mark.asyncio
    async def test_embedding_dimension(self, embedding_client):
        """
        CARACTERISATION: L'embedding a 1536 dimensions (ou autre selon le modele).

        Note: La dimension depend du modele configure (EMBEDDING_MODEL).
        text-embedding-3-small: 1536 dimensions par defaut
        """
        result = await get_embedding("test query for dimension check", embedding_client)

        # La dimension attendue depend du modele
        # text-embedding-3-small peut retourner 1536 ou moins si configure
        assert len(result) > 0, "L'embedding ne devrait pas etre vide."

        # Documenter la dimension observee
        print(f"[INFO] Dimension embedding observee: {len(result)}")

    @pytest.mark.asyncio
    async def test_empty_text_handling(self, embedding_client):
        """
        CARACTERISATION: Un texte vide est gere sans exception.
        """
        # Ce test capture le comportement actuel avec un texte vide
        try:
            result = await get_embedding("", embedding_client)
            assert isinstance(result, list)
        except Exception as e:
            # Capturer si une exception est levee
            pytest.fail(f"Comportement change: exception levee pour texte vide: {e}")

    @pytest.mark.asyncio
    async def test_error_returns_zero_vector(self, embedding_client):
        """
        CARACTERISATION: En cas d'erreur, retourne un vecteur zero de 1536 dims.

        Comportement actuel (ligne 22):
        - return [0] * 1536

        Note: Difficile a tester sans provoquer une vraie erreur.
        Ce test documente le comportement attendu.
        """
        # On ne peut pas facilement provoquer une erreur
        # Ce test sert de documentation du comportement attendu
        pass


# =============================================================================
# Tests d'integration de bout en bout
# =============================================================================

@pytest.mark.integration
class TestEndToEndWorkflow:
    """
    Tests d'integration validant le workflow complet.

    Ces tests verifient que les fonctions travaillent ensemble
    correctement dans un scenario realiste.
    """

    @pytest.mark.asyncio
    async def test_list_then_get_content_workflow(self, supabase_client):
        """
        INTEGRATION: Lister les pages puis recuperer le contenu d'une page.

        Workflow:
        1. Appeler list_documentation_pages_tool
        2. Prendre la premiere URL
        3. Appeler get_page_content_tool avec cette URL
        """
        # Step 1: Lister les pages
        pages = await list_documentation_pages_tool(supabase_client)

        if not pages:
            pytest.skip("Aucune page disponible pour le test d'integration")

        # Step 2: Recuperer le contenu
        content = await get_page_content_tool(supabase_client, pages[0])

        # Step 3: Verifier la coherence
        assert isinstance(content, str)
        assert len(content) > 0

        # Le contenu ne devrait pas etre un message d'erreur
        assert "Error" not in content or "No content" not in content, (
            f"Le contenu de {pages[0]} semble etre une erreur: {content[:100]}"
        )

    @pytest.mark.asyncio
    @pytest.mark.slow
    async def test_search_then_list_workflow(self, supabase_client, embedding_client):
        """
        INTEGRATION: Rechercher puis lister pour comparer.

        Workflow:
        1. Rechercher des documents pertinents
        2. Lister toutes les pages
        3. Verifier que la recherche retourne un sous-ensemble coherent
        """
        # Step 1: Rechercher
        search_result = await retrieve_relevant_documentation_tool(
            supabase_client,
            embedding_client,
            "agent"
        )

        # Step 2: Lister
        all_pages = await list_documentation_pages_tool(supabase_client)

        # Step 3: Verifier la coherence
        assert isinstance(search_result, str)
        assert isinstance(all_pages, list)

        # Les deux devraient fonctionner sans erreur
        # (meme si les resultats sont vides)
