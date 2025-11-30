"""
Tests de validation pour la migration des pages Streamlit (P3-05, P3-06).

Ces tests vérifient que:
1. Les imports fonctionnent correctement
2. Les signatures de fonctions acceptent les nouveaux paramètres
3. Les paramètres repository sont bien typés
"""
import pytest
import sys
import os
import inspect

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from archon.domain import ISitePagesRepository


class TestDatabasePageMigration:
    """Tests pour streamlit_pages/database.py"""

    def test_import_database_page(self):
        """Test que la page database peut être importée"""
        from streamlit_pages.database import database_tab
        assert callable(database_tab)

    def test_database_tab_signature(self):
        """Test que database_tab accepte le paramètre repository"""
        from streamlit_pages.database import database_tab

        sig = inspect.signature(database_tab)
        params = list(sig.parameters.keys())

        assert 'supabase' in params, "database_tab doit avoir un paramètre 'supabase'"
        assert 'repository' in params, "database_tab doit avoir un paramètre 'repository'"

        # Vérifier que repository a une valeur par défaut None
        repo_param = sig.parameters['repository']
        assert repo_param.default is None, "repository doit avoir None comme valeur par défaut"

    def test_repository_parameter_type_hint(self):
        """Test que le paramètre repository a le bon type hint"""
        from streamlit_pages.database import database_tab

        sig = inspect.signature(database_tab)
        repo_param = sig.parameters['repository']

        # Vérifier que l'annotation contient ISitePagesRepository
        annotation_str = str(repo_param.annotation)
        assert 'ISitePagesRepository' in annotation_str, f"Type hint devrait inclure ISitePagesRepository, got: {annotation_str}"

    def test_imports_domain_interface(self):
        """Test que le module importe ISitePagesRepository"""
        import streamlit_pages.database as db_module

        # Vérifier que ISitePagesRepository est dans le namespace
        assert hasattr(db_module, 'ISitePagesRepository'), "Le module devrait importer ISitePagesRepository"

    def test_imports_asyncio(self):
        """Test que le module importe asyncio pour le mode async"""
        import streamlit_pages.database as db_module

        # Vérifier que asyncio est dans le namespace
        assert hasattr(db_module, 'asyncio'), "Le module devrait importer asyncio"


class TestDocumentationPageMigration:
    """Tests pour streamlit_pages/documentation.py"""

    def test_import_documentation_page(self):
        """Test que la page documentation peut être importée"""
        from streamlit_pages.documentation import documentation_tab
        assert callable(documentation_tab)

    def test_documentation_tab_signature(self):
        """Test que documentation_tab accepte le paramètre repository"""
        from streamlit_pages.documentation import documentation_tab

        sig = inspect.signature(documentation_tab)
        params = list(sig.parameters.keys())

        assert 'supabase_client' in params, "documentation_tab doit avoir un paramètre 'supabase_client'"
        assert 'repository' in params, "documentation_tab doit avoir un paramètre 'repository'"

        # Vérifier que repository a une valeur par défaut None
        repo_param = sig.parameters['repository']
        assert repo_param.default is None, "repository doit avoir None comme valeur par défaut"

    def test_repository_parameter_type_hint(self):
        """Test que le paramètre repository a le bon type hint"""
        from streamlit_pages.documentation import documentation_tab

        sig = inspect.signature(documentation_tab)
        repo_param = sig.parameters['repository']

        # Vérifier que l'annotation contient ISitePagesRepository
        annotation_str = str(repo_param.annotation)
        assert 'ISitePagesRepository' in annotation_str, f"Type hint devrait inclure ISitePagesRepository, got: {annotation_str}"

    def test_imports_domain_interface(self):
        """Test que le module importe ISitePagesRepository"""
        import streamlit_pages.documentation as doc_module

        # Vérifier que ISitePagesRepository est dans le namespace
        assert hasattr(doc_module, 'ISitePagesRepository'), "Le module devrait importer ISitePagesRepository"

    def test_imports_asyncio(self):
        """Test que le module importe asyncio pour le mode async"""
        import streamlit_pages.documentation as doc_module

        # Vérifier que asyncio est dans le namespace
        assert hasattr(doc_module, 'asyncio'), "Le module devrait importer asyncio"
