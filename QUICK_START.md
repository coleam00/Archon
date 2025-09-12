# 🚀 Clario Quick Start Guide

## ✅ **What We Have**

You now have **Clario properly built on top of Archon's infrastructure**:
- ✅ **Actual Archon repository** (with all proven infrastructure)  
- ✅ **Clario extensions** (n8n integration, unified search, Founder APIs)
- ✅ **Proper fork setup** (your fork as origin, Archon as upstream)
- ✅ **Clean architecture** (extensions don't conflict with Archon core)

## 🎯 **5-Minute Setup**

### **Step 1: Configure Environment**
```bash
# Copy Archon's environment template
cp .env.example .env

# Edit .env with your credentials:
nano .env
```

**Required in .env:**
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-supabase-service-key
OPENAI_API_KEY=your-openai-api-key
```

### **Step 2: Setup Database**
```bash
# In your Supabase SQL Editor, run the contents of:
cat migration/complete_setup.sql
# Copy and paste into Supabase SQL Editor and execute
```

### **Step 3: Start Services**
```bash
# Start Archon's proven infrastructure
docker-compose up -d

# Wait 30 seconds for services to start, then verify:
curl http://localhost:8181/health  # Archon API
curl http://localhost:8051/health  # Archon MCP
```

### **Step 4: Start Clario**
```bash
# Activate Archon's Python environment
cd python && source .venv/bin/activate && cd ..

# Start Clario knowledge engine
python clario_app.py

# Verify Clario is running:
curl http://localhost:8080/health
```

### **Step 5: Test Integration**
```bash
# Test that everything works together
python test_integration.py

# Should show:
# ✅ PASS Archon Imports
# ✅ PASS Clario Extensions  
# ✅ PASS n8n Data Format
# ✅ PASS Archon Integration
```

## 🎯 **Services Running**

After setup, you'll have:
- **🧠 Archon API:** http://localhost:8181 (proven document processing)
- **📊 Archon UI:** http://localhost:3737 (knowledge base interface)
- **🔍 Archon MCP:** http://localhost:8051 (AI assistant integration)
- **⚡ Clario API:** http://localhost:8080 (business intelligence layer)

## 🔧 **Next: Add n8n**

```bash
# Start n8n workflow automation
docker run -d -p 5678:5678 -v n8n_data:/home/node/.n8n n8nio/n8n

# Open n8n UI
open http://localhost:5678

# Create workflows using examples in N8N_INTEGRATION_STRATEGY.md
```

## 🎯 **Test Business Data Flow**

```bash
# Test n8n → Clario → Archon pipeline
curl -X POST http://localhost:8080/api/n8n/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "jira",
    "entity_type": "issue", 
    "entity_id": "TEST-123",
    "title": "TEST-123: Authentication issue",
    "content": "Users experiencing JWT token problems",
    "url": "https://company.atlassian.net/browse/TEST-123",
    "metadata": {
      "project_key": "TEST",
      "status": "Open"
    },
    "business_context": {
      "platform": "jira",
      "entity_type": "issue"
    }
  }'

# Wait 30 seconds for processing, then search:
curl -X POST http://localhost:8080/api/search/universal \
  -H "Content-Type: application/json" \
  -d '{
    "query": "authentication issue",
    "platforms": ["jira"],
    "maxResults": 5
  }'

# Should return search results showing your test data!
```

## 🔗 **Founder Integration**

**In your Founder codebase, add:**

```typescript
// lib/clario-client.ts
export class ClarioClient {
  constructor(private baseUrl = 'http://localhost:8080') {}
  
  async universalSearch(query: string, platforms: string[] = []) {
    const response = await fetch(`${this.baseUrl}/api/search/universal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        platforms,
        maxResults: 10,
        minRelevance: 0.7
      })
    });
    return response.json();
  }
  
  async askQuestion(question: string, contextPlatforms: string[] = []) {
    const response = await fetch(`${this.baseUrl}/api/search/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        context_platforms: contextPlatforms
      })
    });
    return response.json();
  }
}

// In your command palette component:
const clario = new ClarioClient();

const handleSearch = async (query: string) => {
  if (query.startsWith('?')) {
    // AI question mode
    const answer = await clario.askQuestion(query.slice(1));
    showAIAnswer(answer);
  } else {
    // Universal company search
    const results = await clario.universalSearch(query);
    showSearchResults(results);
  }
};
```

## 🎉 **Result**

**Your users can now:**
- **Search:** "auth bugs" → See results from Jira, GitHub, Slack, Notion
- **Ask:** "?What auth issues have we had?" → Get AI summary with sources  
- **Explore:** Click results to view in Founder's knowledge graph
- **Discover:** See relationships between platforms and content

**Perfect company-wide AI assistant powered by proven Archon infrastructure! 🎯**
