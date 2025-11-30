"""
Tests pour valider la migration Phase 3 - Agents Pydantic AI.

Ces tests vérifient que:
1. Les dataclasses Deps utilisent les interfaces (ISitePagesRepository, IEmbeddingService)
2. Les imports sont corrects
3. Les signatures sont cohérentes
"""
import pytest
import inspect
from dataclasses import is_dataclass, fields

from archon.domain import ISitePagesRepository, IEmbeddingService


class TestPydanticAICoderMigration:
    """Tests pour pydantic_ai_coder.py migration."""

    def test_imports_domain_interfaces(self):
        """Vérifie que le module importe les interfaces domain."""
        # Import tardif pour éviter l'exécution du code module-level
        import sys
        import importlib.util

        # Charger le module sans l'exécuter
        spec = importlib.util.find_spec("archon.pydantic_ai_coder")
        assert spec is not None

        # Vérifier que le fichier contient les imports
        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        assert 'from archon.domain import ISitePagesRepository, IEmbeddingService' in content
        assert 'from supabase import Client' not in content

    def test_deps_dataclass_uses_interfaces(self):
        """Vérifie que PydanticAIDeps utilise les interfaces."""
        # Lire le fichier source
        import importlib.util
        spec = importlib.util.find_spec("archon.pydantic_ai_coder")

        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        # Vérifier la structure de PydanticAIDeps
        assert 'repository: ISitePagesRepository' in content
        assert 'embedding_service: IEmbeddingService' in content
        assert 'supabase: Client' not in content
        assert 'embedding_client: AsyncOpenAI' not in content

    def test_tools_use_new_deps(self):
        """Vérifie que les tools utilisent ctx.deps.repository et ctx.deps.embedding_service."""
        import importlib.util
        spec = importlib.util.find_spec("archon.pydantic_ai_coder")

        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        # Vérifier que les tools passent les bons paramètres
        assert 'repository=ctx.deps.repository' in content
        assert 'embedding_service=ctx.deps.embedding_service' in content


class TestToolsRefinerAgentMigration:
    """Tests pour tools_refiner_agent.py migration."""

    def test_imports_domain_interfaces(self):
        """Vérifie que le module importe les interfaces domain."""
        import importlib.util
        spec = importlib.util.find_spec("archon.refiner_agents.tools_refiner_agent")

        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        assert 'from archon.domain import ISitePagesRepository, IEmbeddingService' in content
        assert 'from supabase import Client' not in content

    def test_deps_dataclass_uses_interfaces(self):
        """Vérifie que ToolsRefinerDeps utilise les interfaces."""
        import importlib.util
        spec = importlib.util.find_spec("archon.refiner_agents.tools_refiner_agent")

        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        assert 'repository: ISitePagesRepository' in content
        assert 'embedding_service: IEmbeddingService' in content


class TestAgentRefinerAgentMigration:
    """Tests pour agent_refiner_agent.py migration."""

    def test_imports_domain_interfaces(self):
        """Vérifie que le module importe les interfaces domain."""
        import importlib.util
        spec = importlib.util.find_spec("archon.refiner_agents.agent_refiner_agent")

        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        assert 'from archon.domain import ISitePagesRepository, IEmbeddingService' in content
        assert 'from supabase import Client' not in content

    def test_deps_dataclass_uses_interfaces(self):
        """Vérifie que AgentRefinerDeps utilise les interfaces."""
        import importlib.util
        spec = importlib.util.find_spec("archon.refiner_agents.agent_refiner_agent")

        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        assert 'repository: ISitePagesRepository' in content
        assert 'embedding_service: IEmbeddingService' in content


class TestAdvisorAgentMigration:
    """Tests pour advisor_agent.py migration."""

    def test_no_unused_imports(self):
        """Vérifie que l'import Client inutilisé a été supprimé."""
        import importlib.util
        spec = importlib.util.find_spec("archon.advisor_agent")

        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        assert 'from supabase import Client' not in content


class TestPromptRefinerAgentMigration:
    """Tests pour prompt_refiner_agent.py migration."""

    def test_no_unused_imports(self):
        """Vérifie que l'import Client inutilisé a été supprimé."""
        import importlib.util
        spec = importlib.util.find_spec("archon.refiner_agents.prompt_refiner_agent")

        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        assert 'from supabase import Client' not in content


class TestArchonGraphMigration:
    """Tests pour archon_graph.py migration."""

    def test_imports_container(self):
        """Vérifie que le module importe le container."""
        import importlib.util
        spec = importlib.util.find_spec("archon.archon_graph")

        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        assert 'from archon.container import get_repository, get_embedding_service' in content
        assert 'from utils.utils import get_env_var' in content
        assert 'from utils.utils import get_env_var, get_clients' not in content

    def test_no_supabase_import(self):
        """Vérifie que l'import Client a été supprimé."""
        import importlib.util
        spec = importlib.util.find_spec("archon.archon_graph")

        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        assert 'from supabase import Client' not in content

    def test_uses_container_for_initialization(self):
        """Vérifie que le graph utilise le container pour initialiser repository et embedding_service."""
        import importlib.util
        spec = importlib.util.find_spec("archon.archon_graph")

        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        # Vérifier l'initialisation
        assert 'repository = get_repository()' in content
        assert 'embedding_service = get_embedding_service()' in content
        assert 'embedding_client, supabase = get_clients()' not in content

    def test_passes_interfaces_to_deps(self):
        """Vérifie que le graph passe repository et embedding_service aux Deps."""
        import importlib.util
        spec = importlib.util.find_spec("archon.archon_graph")

        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        # Vérifier les deps
        assert 'repository=repository' in content
        assert 'embedding_service=embedding_service' in content

    def test_list_documentation_pages_uses_repository(self):
        """Vérifie que list_documentation_pages_tool utilise repository."""
        import importlib.util
        spec = importlib.util.find_spec("archon.archon_graph")

        with open(spec.origin, 'r', encoding='utf-8') as f:
            content = f.read()

        assert 'list_documentation_pages_tool(repository=repository)' in content


class TestMigrationCompleteness:
    """Tests pour vérifier que la migration est complète."""

    def test_all_agents_migrated(self):
        """Vérifie que tous les agents ont été migrés."""
        import importlib.util

        files_to_check = [
            "archon.pydantic_ai_coder",
            "archon.advisor_agent",
            "archon.refiner_agents.tools_refiner_agent",
            "archon.refiner_agents.agent_refiner_agent",
            "archon.refiner_agents.prompt_refiner_agent",
            "archon.archon_graph"
        ]

        for module_name in files_to_check:
            spec = importlib.util.find_spec(module_name)
            assert spec is not None, f"Module {module_name} introuvable"

            with open(spec.origin, 'r', encoding='utf-8') as f:
                content = f.read()

            # Vérifier qu'aucun import supabase.Client ne subsiste
            # (sauf dans les commentaires ou docstrings legacy)
            lines = content.split('\n')
            for i, line in enumerate(lines):
                if 'from supabase import Client' in line:
                    # Vérifier que ce n'est pas un commentaire
                    assert line.strip().startswith('#'), \
                        f"Import Supabase Client trouvé ligne {i+1} dans {module_name}"
