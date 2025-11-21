# Archon Infrastructure Setup

> Dokumentation der lokalen Entwicklungsumgebung mit Supabase und Archon
>
> **Erstellt**: 20. November 2025
> **Status**: ✅ Produktiv
> **Letzte Aktualisierung**: 20. November 2025

---

## 📋 Übersicht

Diese Dokumentation beschreibt die vollständige lokale Entwicklungsumgebung für Archon mit Supabase als Backend-Datenbank.

### Komponenten

- **Supabase** (lokal): PostgreSQL 17.6 mit allen Services
- **Archon**: KI-gestütztes Knowledge Management System
  - Backend Server (FastAPI)
  - MCP Server (Model Context Protocol)
  - Frontend (React)

---

## 🏗️ Architektur

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Desktop                        │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  ┌──────────────────────────────────────────────────┐  │
│  │              Supabase Stack                       │  │
│  │  (verwaltet durch supabase CLI)                   │  │
│  ├──────────────────────────────────────────────────┤  │
│  │  - PostgreSQL 17.6      (Port 54322)             │  │
│  │  - Kong API Gateway     (Port 54321)             │  │
│  │  - Supabase Studio      (Port 54323)             │  │
│  │  - GoTrue Auth          (intern)                 │  │
│  │  - Storage API          (intern)                 │  │
│  │  - Realtime             (intern)                 │  │
│  │  - Edge Functions       (intern)                 │  │
│  │  - Vector/Analytics     (intern)                 │  │
│  └──────────────────────────────────────────────────┘  │
│                                                           │
│  ┌──────────────────────────────────────────────────┐  │
│  │              Archon Stack                         │  │
│  │  (verwaltet durch docker compose)                 │  │
│  ├──────────────────────────────────────────────────┤  │
│  │  - archon-server        (Port 8181)              │  │
│  │  - archon-mcp           (Port 8051)              │  │
│  │  - archon-ui            (Port 3737)              │  │
│  └──────────────────────────────────────────────────┘  │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

---

## 🚀 Installation & Konfiguration

### Voraussetzungen

- Docker Desktop für Mac (läuft bereits)
- Homebrew (installiert)
- Git (installiert)

### 1. Supabase CLI Installation

```bash
brew install supabase/tap/supabase
# Version: 2.58.5
```

### 2. Supabase Initialisierung

```bash
cd /Volumes/DATEN/Coding/archon/supabase
supabase start
```

**Wichtig**: Dies erstellt Container mit dem Suffix `_supabase` (z.B. `supabase_db_supabase`)

### 3. Datenbank-Schema anwenden

```bash
cd /Volumes/DATEN/Coding/archon
docker exec -i supabase_db_supabase psql -U postgres -d postgres < migration/complete_setup.sql
```

Erstellt folgende Tabellen:
- `archon_code_examples`
- `archon_crawled_pages`
- `archon_document_versions`
- `archon_migrations`
- `archon_page_metadata`
- `archon_project_sources`
- `archon_projects`
- `archon_prompts`
- `archon_settings`
- `archon_sources`
- `archon_tasks`

### 4. Umgebungsvariablen konfigurieren

**Datei**: `/Volumes/DATEN/Coding/archon/.env`

```bash
# Supabase Connection (für Docker Container)
SUPABASE_URL=http://host.docker.internal:54321

# JWT Service Role Key (generiert mit lokalem JWT_SECRET)
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3NjM2NTg1MDYsImV4cCI6MjA3OTAxODUwNn0.HVH5TgwW70JZtiGdnjU4RGexDDVbGnI3mXt-diQhVy8

# Service Ports
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_AGENTS_PORT=8052
ARCHON_UI_PORT=3737
ARCHON_DOCS_PORT=3838
```

### 5. Archon Services starten

```bash
cd /Volumes/DATEN/Coding/archon
docker compose up -d
```

---

## 🔑 Wichtige Authentifizierung-Details

### JWT-Token-Problem und Lösung

**Problem**: Die Standard-JWT-Tokens aus `supabase/.env` funktionieren nicht mit der laufenden Supabase-Instanz.

**Ursache**: Supabase CLI generiert beim Start ein neues JWT_SECRET (`super-secret-jwt-token-with-at-least-32-characters-long`), das nicht mit den vordefinierten Tokens übereinstimmt.

**Lösung**: JWT-Token mit dem korrekten Secret generieren:

```python
import jwt
from datetime import datetime, timedelta

secret = "super-secret-jwt-token-with-at-least-32-characters-long"

service_role_payload = {
    "role": "service_role",
    "iss": "supabase",
    "iat": int(datetime.now().timestamp()),
    "exp": int((datetime.now() + timedelta(days=365*10)).timestamp())
}

token = jwt.encode(service_role_payload, secret, algorithm="HS256")
print(token)
```

**Wichtig**: Supabase Python Client (v2.15.1) benötigt JWT-Format, NICHT das neue `sb_secret_*` Format!

---

## 📍 Zugriffspunkte

### Supabase

| Service | URL | Credentials |
|---------|-----|-------------|
| **Studio UI** | http://localhost:54323 | - |
| **API Gateway** | http://localhost:54321 | Service Key (siehe .env) |
| **PostgreSQL** | `postgresql://postgres:postgres@localhost:54322/postgres` | postgres/postgres |

### Archon

| Service | URL | Beschreibung |
|---------|-----|--------------|
| **UI** | http://localhost:3737 | Hauptanwendung |
| **API Server** | http://localhost:8181 | Backend API |
| **MCP Server** | http://localhost:8051 | Model Context Protocol |
| **Health Check** | http://localhost:8181/health | Server-Status |

---

## 🛠️ Wartung & Verwaltung

### Supabase Status prüfen

```bash
cd /Volumes/DATEN/Coding/archon/supabase
supabase status
```

Zeigt:
- API URL
- Database URL
- Studio URL
- Publishable/Secret Keys
- Gestoppte Services

### Container Status

```bash
# Alle Container anzeigen
docker ps --format "table {{.Names}}\t{{.Status}}"

# Nur Archon
docker ps --format "table {{.Names}}\t{{.Status}}" | grep archon

# Nur Supabase
docker ps --format "table {{.Names}}\t{{.Status}}" | grep supabase
```

### Services neu starten

**Supabase**:
```bash
cd /Volumes/DATEN/Coding/archon/supabase
supabase stop
supabase start
```

**Archon**:
```bash
cd /Volumes/DATEN/Coding/archon
docker compose restart
# oder für kompletten Neustart:
docker compose down && docker compose up -d
```

### Logs einsehen

**Supabase**:
```bash
docker logs supabase_db_supabase -f
docker logs supabase_kong_supabase -f
```

**Archon**:
```bash
docker logs archon-server -f
docker logs archon-mcp -f
docker logs archon-ui -f
```

---

## 🐛 Troubleshooting

### Problem: Container mit Status "Created" oder "Restarting"

**Symptom**: Container ohne `_supabase` Suffix existieren und starten nicht.

**Ursache**: Docker Compose hat versehentlich Supabase-Container erstellt (sollte nur Archon verwalten).

**Lösung**:
```bash
# Fehlerhafte Container entfernen
docker rm -f supabase-db supabase-kong supabase-auth supabase-storage \
  supabase-studio supabase-rest supabase-analytics supabase-meta \
  supabase-edge-functions supabase-pooler supabase-vector \
  supabase-imgproxy realtime-dev.supabase-realtime

# Überflüssiges Netzwerk entfernen
docker network rm supabase_default
```

### Problem: "Invalid API key" Fehler

**Symptom**: `SupabaseException: Invalid API key` beim Start von archon-server.

**Ursache**: Falsches JWT-Token-Format oder falsches Secret.

**Lösung**: JWT-Token mit dem tatsächlichen Secret neu generieren (siehe Abschnitt "JWT-Token-Problem").

### Problem: Port-Konflikte

**Symptom**: "Port already in use" beim Start.

**Lösung**:
```bash
# Belegte Ports prüfen
lsof -i :54321  # Supabase API
lsof -i :8181   # Archon Server
lsof -i :3737   # Archon UI

# Container stoppen
supabase stop
docker compose down
```

### Problem: Container "unhealthy"

**Symptom**: Container läuft, aber Status zeigt "unhealthy".

**Diagnose**:
```bash
# Logs prüfen
docker logs <container-name> --tail 50

# Healthcheck-Details
docker inspect <container-name> | grep -A 10 Health
```

**Häufige Ursachen**:
- Datenbankverbindung fehlgeschlagen → JWT-Token prüfen
- Port nicht erreichbar → Netzwerk-Konfiguration prüfen
- Service noch nicht bereit → Warten und Status erneut prüfen

---

## 🗄️ Datenbank-Management

### Direkter Zugriff

```bash
# Via Docker
docker exec -it supabase_db_supabase psql -U postgres -d postgres

# Via lokaler psql (wenn installiert)
psql -h localhost -p 54322 -U postgres -d postgres
```

### Backup erstellen

```bash
# Vollständiges Backup
docker exec supabase_db_supabase pg_dump -U postgres postgres > backup_$(date +%Y%m%d_%H%M%S).sql

# Nur Schema
docker exec supabase_db_supabase pg_dump -U postgres -s postgres > schema_backup.sql

# Nur Daten
docker exec supabase_db_supabase pg_dump -U postgres -a postgres > data_backup.sql
```

### Backup wiederherstellen

```bash
docker exec -i supabase_db_supabase psql -U postgres -d postgres < backup.sql
```

### Migration hinzufügen

1. Neue Migration erstellen:
```bash
cd /Volumes/DATEN/Coding/archon/supabase
supabase migration new <migration_name>
```

2. SQL-Befehle in generierte Datei einfügen

3. Migration anwenden:
```bash
docker exec -i supabase_db_supabase psql -U postgres -d postgres < supabase/migrations/<timestamp>_<migration_name>.sql
```

---

## 🔒 Sicherheit

### Produktionsumgebung

**WICHTIG**: Diese Konfiguration ist NUR für lokale Entwicklung geeignet!

Für Produktion ändern:

1. **JWT Secret** in `supabase/.env` ändern:
```bash
JWT_SECRET=<sicheres-256-bit-secret>
```

2. **Neue JWT-Tokens** generieren mit neuem Secret

3. **PostgreSQL Passwort** ändern:
```bash
POSTGRES_PASSWORD=<sicheres-passwort>
```

4. **Dashboard Credentials** ändern:
```bash
DASHBOARD_USERNAME=<username>
DASHBOARD_PASSWORD=<passwort>
```

5. **Firewall-Regeln** konfigurieren (nur notwendige Ports öffnen)

### API Keys sicher speichern

Archon speichert sensible API Keys verschlüsselt in der Datenbank:
- OpenAI API Key
- Google API Key
- Anthropic API Key
- etc.

Konfiguration über UI: http://localhost:3737/settings

---

## 📊 Ressourcen-Übersicht

### Docker Images (ca. 15.7 GB)

**Archon** (5.69 GB):
- `archon-archon-server`: 3.77 GB
- `archon-archon-frontend`: 1.54 GB
- `archon-archon-mcp`: 385 MB

**Supabase** (~10 GB):
- `public.ecr.aws/supabase/postgres:17.6.1.043`: 4.33 GB
- `public.ecr.aws/supabase/studio`: 1.2 GB
- `public.ecr.aws/supabase/storage-api`: 1.11 GB
- `public.ecr.aws/supabase/edge-runtime`: 1.07 GB
- `public.ecr.aws/supabase/logflare`: 1.02 GB
- `public.ecr.aws/supabase/realtime`: 659 MB
- `public.ecr.aws/supabase/postgrest`: 585 MB
- `public.ecr.aws/supabase/postgres-meta`: 568 MB
- `public.ecr.aws/supabase/kong`: 212 MB
- `public.ecr.aws/supabase/vector`: 160 MB
- `public.ecr.aws/supabase/gotrue`: 74 MB
- `public.ecr.aws/supabase/mailpit`: 43 MB

### Laufende Container (15)

**Archon** (3):
- archon-server
- archon-mcp
- archon-ui

**Supabase** (12):
- supabase_db_supabase
- supabase_kong_supabase
- supabase_studio_supabase
- supabase_auth_supabase
- supabase_storage_supabase
- supabase_realtime_supabase
- supabase_rest_supabase
- supabase_vector_supabase
- supabase_analytics_supabase
- supabase_pg_meta_supabase
- supabase_edge_runtime_supabase
- supabase_inbucket_supabase

---

## 📚 Referenzen

### Offizielle Dokumentation

- **Archon**: https://github.com/coleam00/Archon
- **Supabase**: https://supabase.com/docs
- **Supabase CLI**: https://supabase.com/docs/guides/cli

### Wichtige Konfigurationsdateien

- `/Volumes/DATEN/Coding/archon/.env` - Archon Umgebungsvariablen
- `/Volumes/DATEN/Coding/archon/docker-compose.yml` - Archon Services
- `/Volumes/DATEN/Coding/archon/supabase/.env` - Supabase Konfiguration
- `/Volumes/DATEN/Coding/archon/supabase/volumes/api/kong.yml` - Kong API Gateway
- `/Volumes/DATEN/Coding/archon/migration/complete_setup.sql` - Datenbank-Schema

### Nützliche Befehle (Schnellreferenz)

```bash
# Status prüfen
cd /Volumes/DATEN/Coding/archon
docker ps | grep -E "archon|supabase"
curl http://localhost:8181/health

# Alles neu starten
cd supabase && supabase stop && supabase start
cd .. && docker compose restart

# Alles stoppen
docker compose down
cd supabase && supabase stop

# Logs verfolgen
docker compose logs -f
docker logs archon-server -f

# Datenbank abfragen
docker exec -it supabase_db_supabase psql -U postgres -d postgres
```

---

## 🎯 Nächste Schritte

Nach erfolgreicher Installation:

1. **API Keys konfigurieren** unter http://localhost:3737/settings
   - OpenAI API Key (für Embeddings)
   - Optional: Google, Anthropic, etc.

2. **Knowledge Base befüllen**:
   - Dokumente hochladen
   - Websites crawlen

3. **MCP Server mit IDE verbinden**:
   - Claude Code: `claude mcp add --transport http archon http://localhost:8051/mcp`
   - Cursor/Windsurf: Siehe http://localhost:3737/mcp

4. **Projekte & Tasks erstellen** (optional, wenn Feature aktiviert)

---

## ✅ Verifizierung

Alle Services sollten diesen Status zeigen:

```bash
$ docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "archon|supabase"

archon-mcp                       Up X minutes (healthy)
archon-ui                        Up X minutes (healthy)
archon-server                    Up X minutes (healthy)
supabase_studio_supabase         Up X minutes (healthy)
supabase_db_supabase             Up X minutes (healthy)
supabase_kong_supabase           Up X minutes (healthy)
# ... weitere Supabase Services (alle healthy)
```

Healthcheck-Endpunkte:
- ✅ http://localhost:8181/health → `{"status":"healthy",...}`
- ✅ http://localhost:3737 → Archon UI lädt
- ✅ http://localhost:54323 → Supabase Studio lädt

---

## 📝 Änderungsprotokoll

### 2025-11-20 - Initiale Einrichtung
- Supabase CLI 2.58.5 installiert
- PostgreSQL 17.6 mit Archon-Schema konfiguriert
- JWT-Token-Problem identifiziert und gelöst
- Alle Docker Container bereinigt (Duplikate entfernt)
- Playwright-Tests durchgeführt (alle erfolgreich)
- Status: ✅ Produktiv

---

**Maintainer**: Mathias Boni
**Zuletzt getestet**: 20. November 2025
**Archon Version**: 0.1.0
