# Test Fixtures

Ce dossier contient les donnees de test pour les tests de caracterisation et unitaires.

## Structure

```
fixtures/
  test_site_pages.json     # Donnees de pages de test
  test_embeddings.json     # Embeddings pre-calcules (optionnel)
```

## Fichiers

### test_site_pages.json (a creer)

Contient des exemples de donnees `site_pages` pour les tests:

```json
[
  {
    "url": "https://docs.example.com/intro",
    "chunk_number": 1,
    "title": "Introduction",
    "summary": "Introduction to the framework",
    "content": "Full content here...",
    "metadata": {
      "source": "test_characterization",
      "chunk_size": 1000
    }
  }
]
```

### test_embeddings.json (optionnel)

Embeddings pre-calcules pour eviter les appels API OpenAI:

```json
{
  "intro_chunk_1": [0.123, -0.456, ...],
  "intro_chunk_2": [0.789, -0.012, ...]
}
```

## Usage

Les fixtures sont chargees via les fixtures pytest dans `conftest.py`:

```python
@pytest.fixture
def sample_pages(fixtures_path):
    with open(fixtures_path / "test_site_pages.json") as f:
        return json.load(f)
```

## Notes

- Les embeddings sont des vecteurs de dimension 1536 (modele OpenAI ada-002)
- Utiliser `source: "test_characterization"` pour l'isolation en production
- Utiliser `source: "test_unit"` pour les tests locaux

---

*Bloc Manifest: P0-02*
