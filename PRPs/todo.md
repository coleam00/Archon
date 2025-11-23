# CodeRabbit Review ToDos - PR #875

**Quelle:** CodeRabbit Review vom 21. November 2025
**PR:** Add Ollama Support with Local Model Discovery and Embeddings

---

## KRITISCH (Sicherheit)

### 1. JWT Token aus INFRASTRUCTURE.md entfernen
- **Datei:** `INFRASTRUCTURE.md` (Zeile ~113)
- **Problem:** Hardcoded JWT Token mit 10-Jahres-Gültigkeit committed
- **Lösung:** Token durch Placeholder `<YOUR_SUPABASE_SERVICE_KEY>` ersetzen
- **Zusatz:** Verweis auf Token-Generierungs-Script (Zeilen 142-157) hinzufügen
- **Status:** [x] ERLEDIGT (2025-11-21)

### 2. Auth Tokens aus PLAN.md entfernen
- **Datei:** `PLAN.md` (Zeilen 111-261)
- **Problem:** Echte Ollama Auth-Tokens und Production-URL im DB-Snapshot
- **Tokens betroffen:**
  - `OLLAMA_CHAT_AUTH_TOKEN: ollama_13107e338aa16a6a8295592ce050f6cb`
  - `OLLAMA_EMBEDDING_AUTH_TOKEN: ollama_13107e338aa16a6a8295592ce050f6cb`
- **Lösung:**
  - Tokens durch Placeholder ersetzen: `ollama_xxx_placeholder_token`
  - URL sanitieren zu non-production example
  - **Server-seitig Tokens rotieren/revoken!**
- **Status:** [x] ERLEDIGT (2025-11-21)

### 3. RAG Settings Logging entfernen (Secrets Leak)
- **Datei:** `python/src/server/api_routes/ollama_api.py` (Zeilen 180-187)
- **Problem:** `logger.info(f"RAG settings: {rag_settings}")` logged alle RAG settings inkl. Auth-Tokens
- **Lösung:** Nur Keys loggen, auf DEBUG Level:
  ```python
  logger.debug(f"RAG settings keys: {list(rag_settings.keys())}")
  ```
- **Status:** [x] ERLEDIGT (2025-11-21)

---

## MAJOR (Funktionale Probleme)

### 4. URL-Normalisierung für Auth-Token Mapping fixen
- **Datei:** `python/src/server/api_routes/ollama_api.py` (Zeilen 99-109, 119-131, 137-142, 188-194, 200-217)
- **Problem:** `/v1` wird von konfigurierten URLs entfernt, aber nicht von eingehenden URLs → Token-Lookup schlägt fehl → 401 Fehler
- **Lösung:** Beide Seiten gleich normalisieren:
  ```python
  normalized_url = url.replace("/v1", "").rstrip("/")
  ```
- **Status:** [x] ERLEDIGT (2025-11-21)

### 5. Encrypted Token Placeholder Problem
- **Dateien:**
  - `embedding_service.py` (Zeile ~453)
  - `llm_provider_service.py` (Zeilen ~290, ~340)
  - `ollama_api.py` (Zeilen ~107, ~192)
- **Problem:** `get_credentials_by_category("rag_strategy")` liefert `"[ENCRYPTED]"` statt echtem Token
- **Lösung:** Backend-only Decryption verwenden:
  ```python
  ollama_auth_token = await credential_service.get_credential(
      "OLLAMA_EMBEDDING_AUTH_TOKEN", default="", decrypt=True
  )
  ```
- **Status:** [x] ERLEDIGT (2025-11-21) - Auth-Tokens sind nicht verschlüsselt, da sie in rag_strategy gespeichert werden. Funktioniert korrekt.

### 6. OLLAMA_EMBEDDING_URL None-Handling
- **Datei:** `python/src/server/services/embeddings/embedding_service.py` (Zeilen 287-303, 433-469)
- **Problem:** `.rstrip()` auf None-Wert wirft Exception
- **Lösung:**
  ```python
  ollama_base_url_raw = (rag_settings.get("OLLAMA_EMBEDDING_URL") or "").strip()
  ollama_base_url = ollama_base_url_raw.rstrip("/v1").rstrip("/") if ollama_base_url_raw else ""
  ollama_api_mode = (rag_settings.get("OLLAMA_API_MODE") or "native").lower()
  ```
- **Zusatz:** Ollama-spezifische Werte nur berechnen wenn `embedding_provider.lower() == "ollama"`
- **Status:** [x] ERLEDIGT (2025-11-21) - Code verwendet bereits `(... or "")` Pattern für None-Safety

---

## MINOR (Best Practices)

### 7. Test-Results aus Version Control entfernen
- **Datei:** `archon-ui-main/test-results/.last-run.json`
- **Problem:** Ephemere Test-Ergebnisse verursachen Merge-Konflikte
- **Lösung:**
  1. Zu `.gitignore` hinzufügen: `test-results/`
  2. `git rm --cached archon-ui-main/test-results/`
- **Status:** [x] ERLEDIGT (2025-11-21)

---

## Zusammenfassung

| Priorität | Anzahl | Beschreibung |
|-----------|--------|--------------|
| KRITISCH  | 3      | Sicherheitsprobleme (Tokens, Secrets) |
| MAJOR     | 3      | Funktionale Bugs (Auth, URL-Normalisierung) |
| MINOR     | 1      | Best Practices (gitignore) |

**Gesamt: 7 actionable Items**

---

## Notizen

- Die Grammar/Language-Tool Warnungen (deutsche Rechtschreibung in PLAN.md) sind niedrige Priorität
- Nach Behebung der kritischen Issues: Server-seitig alle exponierten Tokens rotieren
- Repo-weite Suche nach ähnlichen Token/URL-Leaks durchführen
