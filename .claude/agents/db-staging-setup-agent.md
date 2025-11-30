# Agent: db-staging-setup-agent

## Purpose
Agent specialise pour lancer et valider l'instance staging d'Archon avec le backend PostgreSQL.

## Context File
**IMPORTANT**: Lire le fichier de contexte pour l'état complet de la session:
- `docs/CONTEXT_DB_STAGING_AGENT.md` - État actuel, historique, prochaines étapes

## Current State (2024-11-30)

### Setup Complete
| Component | Status | Location |
|-----------|--------|----------|
| `.env.staging` | CREATED | `D:\archon\archon\.env.staging` |
| `Dockerfile.staging` | CREATED | `D:\archon\archon\Dockerfile.staging` |
| `run_staging.py` | CREATED | `D:\archon\archon\run_staging.py` |
| `graph_service.py` | MODIFIED | Port override via `GRAPH_SERVICE_PORT` |
| `archon/container.py` | MODIFIED | Backend override via `REPOSITORY_TYPE` |

### Infrastructure
| Service | Status | Details |
|---------|--------|---------|
| PostgreSQL | RUNNING | `mg_postgres` on localhost:5432/mydb |
| pgvector | INSTALLED | v0.8.1 |
| Backend Tests | PASSED | 16/16 tests |

### Port Configuration
| Service | Production | Staging |
|---------|------------|---------|
| Streamlit UI | 8501 | **8502** |
| Graph Service | 8100 | **8101** |
| Database | Supabase | PostgreSQL |

## Quick Commands

### Launch Staging
```bash
cd D:\archon\archon
python run_staging.py
```

### Check Status
```bash
# Container status
docker ps --filter "name=archon-staging"

# View logs
docker logs archon-staging -f

# Health check
curl http://localhost:8101/health
```

### Stop Staging
```bash
docker stop archon-staging && docker rm archon-staging
```

### Verify PostgreSQL Data
```bash
docker exec -it mg_postgres psql -U postgres -d mydb -c "SELECT COUNT(*) FROM site_pages;"
```

## Validation Checklist

After launching, verify:

### Phase 1: Container Running
- [ ] `docker ps` shows `archon-staging` container
- [ ] Status is "Up" (not "Exited")
- [ ] Ports 8502 and 8101 are mapped

### Phase 2: Services Responding
- [ ] http://localhost:8502 - Streamlit UI loads
- [ ] http://localhost:8101/health - Returns `{"status": "ok"}`

### Phase 3: Backend Verification
- [ ] Environment page shows PostgreSQL config
- [ ] Can crawl a small documentation site
- [ ] Data appears in PostgreSQL (not Supabase)

### Phase 4: Production Intact
- [ ] http://localhost:8501 - Production UI still works
- [ ] http://localhost:8100/health - Production API still works

## Troubleshooting

### Container won't start
```bash
# Check logs for errors
docker logs archon-staging

# Common issues:
# - Port already in use: Stop conflicting container
# - .env.staging missing: Verify file exists
# - Build failed: Check Dockerfile.staging
```

### PostgreSQL connection refused
```bash
# Verify PostgreSQL is running
docker ps | findstr mg_postgres

# If not running:
docker start mg_postgres

# Test connection from host
docker exec -it mg_postgres psql -U postgres -d mydb -c "SELECT 1;"
```

### Graph Service not responding on 8101
```bash
# Check if service started inside container
docker exec archon-staging ps aux | grep uvicorn

# Check environment variable
docker exec archon-staging env | grep GRAPH_SERVICE_PORT
```

### Data going to Supabase instead of PostgreSQL
```bash
# Verify REPOSITORY_TYPE is set
docker exec archon-staging env | grep REPOSITORY_TYPE

# Should show: REPOSITORY_TYPE=postgres
# If missing, check .env.staging file
```

## Rollback

If anything fails, staging can be removed without affecting production:

```bash
# Stop and remove staging
docker stop archon-staging
docker rm archon-staging

# Production continues on 8501/8100
curl http://localhost:8100/health  # Should still work
```

## Files Reference

| File | Purpose |
|------|---------|
| `.env.staging` | Environment config with API keys |
| `Dockerfile.staging` | Docker image for staging |
| `run_staging.py` | Launch script with checks |
| `docs/CONTEXT_STAGING_SETUP.md` | Full documentation |

## Next Steps After Validation

Once staging is validated:
1. Test full workflow (crawl docs, RAG search, agent creation)
2. Compare performance with production Supabase
3. Consider data migration strategy if switching production
4. Document any differences in behavior
