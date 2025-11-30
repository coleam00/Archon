#!/usr/bin/env python
"""
Script de validation de la fondation (Phases 1-2)
Exécuter: python scripts/validate_foundation.py
"""

import sys
import subprocess
import os

# S'assurer qu'on est dans le bon répertoire
script_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(script_dir)
os.chdir(project_root)


def run_check(name: str, command: str) -> bool:
    """Exécute une commande et retourne True si succès."""
    print(f"\n{'='*60}")
    print(f"CHECK: {name}")
    print(f"{'='*60}")

    result = subprocess.run(command, shell=True, capture_output=True, text=True)

    if result.returncode == 0:
        print(f"✅ PASS: {name}")
        if result.stdout:
            # Limiter l'output pour lisibilité
            lines = result.stdout.strip().split('\n')
            if len(lines) > 20:
                print('\n'.join(lines[:10]))
                print(f"... ({len(lines) - 20} lignes omises) ...")
                print('\n'.join(lines[-10:]))
            else:
                print(result.stdout)
        return True
    else:
        print(f"❌ FAIL: {name}")
        if result.stderr:
            print(f"STDERR:\n{result.stderr}")
        if result.stdout:
            print(f"STDOUT:\n{result.stdout}")
        return False


def main():
    print("="*60)
    print("VALIDATION DE LA FONDATION - Phases 1 & 2")
    print("Database Layer Refactoring - Archon")
    print("="*60)

    checks = [
        # Imports structurels
        ("Import archon.domain",
         'python -c "from archon.domain import SitePage, SitePageMetadata, SearchResult, ISitePagesRepository, IEmbeddingService; print(\'OK - 5 composants importés\')"'),

        ("Import archon.infrastructure.supabase",
         'python -c "from archon.infrastructure.supabase import SupabaseSitePagesRepository; print(\'OK - SupabaseSitePagesRepository\')"'),

        ("Import archon.infrastructure.memory",
         'python -c "from archon.infrastructure.memory import InMemorySitePagesRepository; print(\'OK - InMemorySitePagesRepository\')"'),

        ("Import archon.infrastructure.openai",
         'python -c "from archon.infrastructure.openai import OpenAIEmbeddingService; print(\'OK - OpenAIEmbeddingService\')"'),

        ("Pas de dépendances circulaires",
         'python -c "import archon.domain; import archon.infrastructure; print(\'OK - Pas de cycle\')"'),

        # Tests unitaires
        ("Tests domain (modèles + interfaces)",
         'pytest tests/domain/ -v --tb=short -q'),

        ("Tests infrastructure (mappers + memory repo)",
         'pytest tests/infrastructure/ -v --tb=short -q'),

        # Validation des interfaces
        ("ISitePagesRepository - méthodes abstraites",
         '''python -c "
from archon.domain.interfaces import ISitePagesRepository
import inspect
methods = [m for m in dir(ISitePagesRepository) if not m.startswith('_')]
expected = ['count', 'delete_by_source', 'find_by_url', 'get_by_id', 'insert', 'insert_batch', 'list_unique_urls', 'search_similar']
assert set(methods) == set(expected), f'Missing methods: {set(expected) - set(methods)}'
print(f'OK - {len(methods)} méthodes: {methods}')
"'''),

        ("IEmbeddingService - méthodes abstraites",
         '''python -c "
from archon.domain.interfaces import IEmbeddingService
import inspect
methods = [m for m in dir(IEmbeddingService) if not m.startswith('_')]
expected = ['get_embedding', 'get_embeddings_batch']
assert set(methods) == set(expected), f'Missing methods: {set(expected) - set(methods)}'
print(f'OK - {len(methods)} méthodes: {methods}')
"'''),
    ]

    results = []
    for name, cmd in checks:
        results.append((name, run_check(name, cmd)))

    # Résumé
    print(f"\n{'='*60}")
    print("RÉSUMÉ DE VALIDATION")
    print(f"{'='*60}\n")

    passed = sum(1 for _, ok in results if ok)
    total = len(results)

    for name, ok in results:
        status = "✅" if ok else "❌"
        print(f"{status} {name}")

    print(f"\n{'='*60}")
    print(f"Résultat: {passed}/{total} checks passés")
    print(f"{'='*60}")

    if passed == total:
        print("\n🎉 FONDATION VALIDÉE!")
        print("   La base est solide pour continuer vers Phase 3.")
        print("\n   Prochaines étapes:")
        print("   1. git add archon/domain/ archon/infrastructure/ tests/")
        print("   2. git commit -m 'feat(db-refactor): Phase 1-2 complete'")
        print("   3. Continuer avec Phase 3 (Migration)")
        return 0
    else:
        print("\n⚠️  FONDATION INCOMPLÈTE")
        print("   Des corrections sont nécessaires avant de continuer.")
        print("\n   Actions:")
        print("   1. Corriger les checks en échec")
        print("   2. Relancer ce script")
        return 1


if __name__ == "__main__":
    sys.exit(main())
