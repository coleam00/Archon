## Schritt 07 – Protokoll: DB-Migration (Targeted Indexes)

### Datum
- 2025-09-09

### Kontext & Ziel
- Ziel: Beschleunigung typischer Task-Listenabfragen über `archon_tasks` durch gezielte Indizes.
- Bezug: Phase 1, Step 07 (siehe `Upgrade/tasks/phase1/steps/07-db-migration.md`).
- Voraussetzung: Step 06 (Server-side Validation) ist abgeschlossen; Neuinstallationen sollen ohne manuelle Schritte direkt korrekt performen.

### Was wurde gemacht und warum
1) Neuer Migrationsschritt (Upgrade bestehender Installationen):
   - Datei: `migration/07_add_archon_tasks_indexes.sql`
   - Inhalt: Zusammengesetzter Index auf `(project_id, status, task_order)`; optional (auskommentiert) GIN-Index für Volltextsuche auf `description`.
   - Warum: Standard-Listen im Code filtern `project_id`+`status` und sortieren nach `task_order`. Der Composite Index deckt genau das Query-Pattern ab und reduziert Seq Scan + Sort.
   - `CONCURRENTLY`: für Zero-Downtime-Charakter bei Live-Systemen.

2) Aufnahme in Initial-Setup (Neuinstallationen):
   - Datei: `migration/complete_setup.sql` – Index-Erzeugung direkt nach `CREATE TABLE archon_tasks` eingefügt.
   - Warum: Damit frische Setups ohne Zusatzschritte performen. Hier bewusst ohne `CONCURRENTLY` (typisch leere DB/Transaktion; zuverlässig und schnell).

3) Dokumentation konsultiert (Context7 MCP):
   - Supabase CLI/Migrations: Vorgehen bei Migrationen/Repair/Diagnose.
   - PostgreSQL `CREATE INDEX CONCURRENTLY`: Eigenschaften, Einschränkungen (nicht in Transaktionen), Verhalten bei Fehlerfällen.

### Wie wurde es umgesetzt
- Neu: `migration/07_add_archon_tasks_indexes.sql`
  - `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_archon_tasks_project_status_order ON archon_tasks(project_id, status, task_order);`
  - Optionaler, auskommentierter GIN-Index auf `to_tsvector('english', description)`.
  - Hinweise: Validierung (\di, EXPLAIN, `pg_stat_user_indexes`) und Rollback.
- Geändert: `migration/complete_setup.sql`
  - Direkt nach `CREATE TABLE IF NOT EXISTS archon_tasks (...)` eingefügt:
    - `CREATE INDEX IF NOT EXISTS idx_archon_tasks_project_status_order ON archon_tasks(project_id, status, task_order);`
    - Optional auskommentierter GIN-Index.

### Was hat funktioniert
- Trennung Neuinstallation vs. Upgrade:
  - Neuinstallation: Indizes automatisch über `complete_setup.sql`.
  - Upgrade: Separate Datei mit `CONCURRENTLY`, sicher bei laufenden Writes.
- Index entspricht realem Nutzungsmuster im Service (`project_id`, `status`, `task_order`).
- Idempotenz durch `IF NOT EXISTS` vermeidet Fehler bei Mehrfachausführung.

### Was hat nicht funktioniert / Fallstricke & Lösung
- `CONCURRENTLY` ist nicht innerhalb einer Transaktion erlaubt.
  - Lösung: Upgrade-Skript so dokumentiert, dass Statements einzeln ausgeführt werden; im Initial-Setup kein `CONCURRENTLY`.
- Optionaler FTS-Index nur sinnvoll, wenn Phase 1 Volltextsuche wirklich nutzt.
  - Lösung: Standardmäßig auskommentiert mit klarer Aktivierungsanweisung.

### Validierungsplan (manuell bei Bedarf)
1) Index-Existenz: `\di+ idx_archon_tasks_*`
2) Explain-Plan (typische Liste):
   - `EXPLAIN ANALYZE SELECT id FROM archon_tasks WHERE project_id = '<uuid>' AND status = 'todo' ORDER BY task_order LIMIT 50;`
3) Nutzungsstatistik: `SELECT * FROM pg_stat_user_indexes WHERE indexrelname LIKE 'idx_archon_tasks_%';`

### Risiken & Auswirkungen
- Gering: Indizes sind additive Optimierung ohne Schema-Inkompatibilitäten.
- Bei großen Tabellen kann die Erzeugung (auch `CONCURRENTLY`) dauern → deshalb Trennung initial vs. upgrade.

### Nächste Schritte
- Docs ergänzen (Getting Started/README): Hinweis, dass Indizes im Initial-Setup enthalten sind; für Upgrades: `migration/07_add_archon_tasks_indexes.sql` nutzen.
- Step 08 (Tests/Benchmarks) angehen: einfache Benchmarks/`EXPLAIN`-Vergleiche dokumentieren.
- Optional: FTS-Index aktivieren, falls in Phase 1 benötigt, und Dokumentation erweitern.

### Geänderte/Neue Dateien
- Neu: `migration/07_add_archon_tasks_indexes.sql`
- Geändert: `migration/complete_setup.sql`

