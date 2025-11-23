# Mexico Document Processor System 🇲🇽

## Overview

The Mexico Document Processor is a comprehensive multi-agent system designed to help people navigate Mexican bureaucracy and obtain government documents. This system is especially valuable for people who have worked in the US under a Social Security Number and need to recover AFORE retirement funds or obtain other Mexican documentation.

## What It Does

This system helps users obtain ANY Mexican government document including:

- 🚗 **Driver's Licenses** (Licencias de conducir)
- 🆔 **State IDs / Voter IDs** (INE/IFE)
- 🛂 **Passports** (Pasaportes mexicanos)
- 📋 **Visa Permits** (Permisos de visa / Formas migratorias)
- 💍 **Marriage Certificates** (Actas de matrimonio)
- 👶 **Birth Certificates** (Actas de nacimiento)
- 🏠 **Property Tax Documents** (Prediales)
- 📜 **Property Deeds** (Escrituras)
- 🚙 **Vehicle Insurance** (Seguros vehiculares)
- 💰 **AFORE Retirement Fund Recovery** (Recuperación de fondos AFORE)
- 🔢 **CURP** (Clave Única de Registro de Población)
- 📊 **RFC** (Registro Federal de Contribuyentes)

## System Architecture

### 1. **Multi-Agent System**

#### MexicoDocumentAgent (`python/src/agents/mexico_document_agent.py`)
- Main coordinating agent that understands user needs
- Manages document request workflows
- Coordinates with other agents
- Tracks progress and provides updates
- Calculates costs and timelines

#### MexicoScraperAgent (`python/src/agents/mexico_scraper_agent.py`)
- Specialized in web scraping Mexican government websites
- Extracts latest requirements, fees, procedures
- Handles regional variations (different states)
- Parses Spanish-language content
- Detects changes in requirements

### 2. **Database Schema** (`database/migrations/mexico_documents_schema.sql`)

Tables created:
- `mexico_document_requests` - Main request tracking
- `mexico_scraped_data` - Cached government website data
- `mexico_document_progress` - Individual document progress
- `mexico_form_templates` - Form templates for auto-filling
- `mexico_applicant_profiles` - Saved user profiles for quick reuse

### 3. **MCP Tools** (`python/src/mcp_server/features/mexico_docs/`)

Exposes tools to AI assistants (Cursor, Windsurf, Claude Desktop):

- `mexico_list_document_types` - List all available documents
- `mexico_get_document_requirements` - Get detailed requirements
- `mexico_create_document_request` - Start a new request
- `mexico_get_request_status` - Check request status
- `mexico_update_request_progress` - Update progress
- `mexico_search_afore_funds` - Search for AFORE retirement funds
- `mexico_auto_fill_form` - Auto-fill government forms

## Key Features

### 1. **Multi-Document Batch Processing**
Users can request multiple documents at once. The system:
- Validates all requested documents
- Calculates combined costs
- Determines overall timeline
- Provides unified next steps

### 2. **AFORE Recovery Assistance** 💰
Special focus on helping people recover retirement funds they didn't know they had:
- Search for existing AFORE accounts
- Estimate fund balances
- Provide recovery procedures
- Track required documentation

### 3. **Web Scraping for Latest Info** 🔍
Government requirements change frequently:
- Scrapes official .gob.mx websites
- Caches data to reduce redundant requests
- Detects changes in fees or requirements
- Stores scraped data with timestamps

### 4. **Automated Form Filling** 📝
Saves users time and reduces errors:
- Form templates for common documents
- Maps user data to form fields
- Generates pre-filled forms
- Provides submission instructions

### 5. **Progress Tracking** 📊
Complete visibility into the process:
- Steps completed
- Next actions required
- Documents obtained
- Costs (estimated vs actual)
- Timeline estimates

## Usage Examples

### Example 1: Getting a Passport and Driver's License

```python
# Via MCP tool from AI assistant
await mexico_create_document_request(
    document_codes=["pasaporte", "licencia"],
    applicant_name="Juan Pérez González",
    curp="PEGJ850101HDFRLN09",
    state="Jalisco",
    user_id="user_123"
)

# Returns:
{
  "success": true,
  "request_id": "MX-A1B2C3D4",
  "message": "Successfully created request for 2 document(s)",
  "documents_requested": ["Mexican Passport", "Driver's License"],
  "next_steps": [
    "Review required documents for each document type",
    "Gather all required identification and documents",
    "Check government websites for latest procedures",
    "Schedule appointments if required",
    "Prepare payment methods"
  ],
  "estimated_timeline_weeks": 6,
  "estimated_total_cost_mxn": 2495.0
}
```

### Example 2: AFORE Recovery

```python
# Search for AFORE funds
await mexico_search_afore_funds(
    full_name="María González López",
    nss="12345678901",  # Social Security Number from US work
    curp="GOLM750615MDFRPR03",
    years_worked=15
)

# Returns information about potential AFORE balance and recovery steps
```

### Example 3: Checking Request Status

```python
await mexico_get_request_status(request_id="MX-A1B2C3D4")

# Returns current status, steps completed, next actions
```

## Integration Points

### Frontend Integration
The system is designed to integrate with the existing Archon UI:
- Add Mexico Documents section to navigation
- Create forms for document requests
- Display progress tracking
- Show cost estimates and timelines

### API Endpoints (To Be Created)
- `POST /api/mexico-docs/requests` - Create new request
- `GET /api/mexico-docs/requests/:id` - Get request status
- `PUT /api/mexico-docs/requests/:id` - Update request
- `GET /api/mexico-docs/document-types` - List available documents
- `POST /api/mexico-docs/scrape` - Trigger web scraping
- `POST /api/mexico-docs/auto-fill` - Generate filled forms

## Installation & Setup

### 1. Database Setup
```bash
# Run migration
psql -U postgres -d archon < database/migrations/mexico_documents_schema.sql
```

### 2. Environment Variables
No additional environment variables required - uses existing Supabase configuration.

### 3. MCP Server Registration
Add to `python/src/mcp_server/mcp_server.py`:
```python
from src.mcp_server.features.mexico_docs import register_mexico_docs_tools
register_mexico_docs_tools(mcp)
```

## Development Roadmap

### Phase 1: Core Infrastructure ✅
- [x] Multi-agent system (MexicoDocumentAgent, MexicoScraperAgent)
- [x] Database schema
- [x] MCP tools foundation

### Phase 2: API & Frontend (In Progress)
- [ ] RESTful API endpoints
- [ ] Frontend UI components
- [ ] Request management dashboard
- [ ] Progress tracking visualizations

### Phase 3: Advanced Features
- [ ] Real web scraping (currently simulated)
- [ ] PDF form filling
- [ ] Appointment scheduling integration
- [ ] Payment tracking
- [ ] Document upload/storage
- [ ] Email/SMS notifications

### Phase 4: Scaling & Optimization
- [ ] Batch processing optimization
- [ ] Cache management for scraped data
- [ ] Regional office location mapping
- [ ] Multi-language support (English/Spanish)

## Technical Details

### Document Type Catalog
All document types are defined in `MEXICO_DOCUMENT_TYPES` with:
- English and Spanish names
- Government agency responsible
- Typical processing times
- Cost estimates
- Required documents list
- Online availability

### Web Scraping Strategy
- Targets official .gob.mx domains only
- Caches scraped data to reduce load
- Timestamps all data for freshness tracking
- Handles state-specific variations
- Parses Spanish-language content

### Form Auto-Filling
- Templates stored in `mexico_form_templates` table
- Field mapping from applicant data
- Support for various field types (text, date, address, etc.)
- Validation before submission

## Security & Privacy

- Row Level Security (RLS) enabled on all tables
- Users can only access their own requests
- Scraped data is public (read-only)
- No sensitive data stored unencrypted
- Supabase authentication integration

## Support & Contribution

This system is designed to help people fight for what's rightfully theirs - their identity, their property, their retirement money. It makes navigating Mexican bureaucracy easier and more accessible.

### Key Benefits
1. **Time Savings**: Batch processing multiple documents
2. **Cost Transparency**: Clear estimates upfront
3. **Progress Visibility**: Know exactly where you are
4. **Expert Guidance**: Step-by-step instructions
5. **AFORE Recovery**: Help recovering forgotten funds

## License

Part of the Archon project. See main LICENSE file for details.

---

**Note**: This system simulates web scraping in the current implementation. For production use, implement actual HTTP requests and HTML parsing using libraries like `httpx` and `BeautifulSoup4` or `Playwright` for JavaScript-heavy sites.
