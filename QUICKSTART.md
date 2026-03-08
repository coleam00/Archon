# Archon + Supabase - Quick Start Guide

> Schnellstart für die lokale Entwicklungsumgebung

## ⚡ Schnellstart (für erfahrene Entwickler)

```bash
# 1. Supabase starten
cd supabase
supabase start

# 2. Archon starten
cd ..
docker compose up -d

# 3. Status prüfen
docker ps | grep -E "archon|supabase"
curl http://localhost:8181/health
```

## 🌐 Zugriff

| Service | URL | Beschreibung |
|---------|-----|-------------|
| **Archon UI** | http://localhost:3737 | Hauptanwendung |
| **Supabase Studio** | http://localhost:54323 | Datenbank-UI |
| **API Server** | http://localhost:8181 | Backend API |
| **MCP Server** | http://localhost:8051/mcp | Model Context Protocol |

## 🛑 Stoppen

```bash
# Archon stoppen
docker compose down

# Supabase stoppen
cd supabase && supabase stop
```

## 📚 Vollständige Dokumentation

Siehe **[INFRASTRUCTURE.md](./INFRASTRUCTURE.md)** für:
- Detaillierte Installation
- Troubleshooting
- Datenbank-Management
- Sicherheitshinweise
- Backup/Restore
