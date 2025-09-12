# n8n Integration Strategy for Clario

## 🎯 **Why n8n is Perfect for This**

**Instead of building custom connectors, leverage n8n's 400+ pre-built integrations:**

### ✅ **Massive Time Savings**
- **Jira Integration**: Pre-built, battle-tested
- **Notion Integration**: Pre-built, handles all API complexities  
- **Slack Integration**: Pre-built with webhook support
- **GitHub Integration**: Pre-built with real-time events
- **400+ other platforms**: Google Workspace, Linear, Asana, etc.

### ✅ **Enterprise Features**
- **Real-time webhooks**: Instant updates when data changes
- **Error handling**: Built-in retry logic and failure notifications
- **Rate limiting**: Automatic handling of API limits
- **Authentication**: OAuth, API keys, etc. all handled
- **Visual workflows**: Non-technical users can configure integrations

### ✅ **Perfect Architecture Fit**
- n8n extracts & transforms data from business platforms
- Clario processes data through Archon's proven pipeline
- Clean separation of concerns

## 🏗️ **Architecture: n8n + Clario + Archon**

```
┌─────────────────────────────────────────────────────────────────┐
│                    Business Platforms                          │
│  Jira • Notion • Slack • GitHub • Linear • Google Workspace   │
└─────────────────────┬───────────────────────────────────────────┘
                      │ APIs, Webhooks, Events
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                        n8n Workflows                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │Jira → Data  │  │Slack → Data │  │Notion→ Data │             │
│  │Extraction   │  │Extraction   │  │Extraction   │             │
│  │& Transform  │  │& Transform  │  │& Transform  │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
└─────────────────────┬───────────────────────────────────────────┘
                      │ Standardized JSON
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Clario Ingestion API                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ POST /api/clario/ingest                                 │   │
│  │ - Validates n8n data                                   │   │
│  │ - Applies business rules                               │   │
│  │ - Queues for Archon processing                         │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────┬───────────────────────────────────────────┘
                      │ Clario Format
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│              Archon Processing Pipeline                         │
│  🧠 Document Chunking • Vector Embeddings • RAG Search         │
│  🗄️ PostgreSQL + pgvector Storage                              │
│  🔍 Hybrid Search (Vector + Full-Text)                         │
└─────────────────────┬───────────────────────────────────────────┘
                      │ Processed Knowledge
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Founder Frontend                            │
│  💬 Universal Search • AI Q&A • Knowledge Graph               │
└─────────────────────────────────────────────────────────────────┘
```

## 🚀 **Implementation: n8n Workflows**

### **1. Jira Issues Workflow**

```json
{
  "name": "Jira to Clario Sync",
  "nodes": [
    {
      "name": "Jira Trigger",
      "type": "n8n-nodes-base.jiraTrigger",
      "parameters": {
        "events": ["jira:issue_created", "jira:issue_updated"],
        "jqlFilter": "project in (PROJ, TEAM)"
      }
    },
    {
      "name": "Transform Data",
      "type": "n8n-nodes-base.code",
      "parameters": {
        "code": `
          // Transform Jira issue to Clario format
          const issue = $input.item.json;
          
          return {
            platform: "jira",
            entity_type: "issue",
            entity_id: issue.id,
            title: \`\${issue.key}: \${issue.fields.summary}\`,
            content: issue.fields.description || '',
            url: \`https://company.atlassian.net/browse/\${issue.key}\`,
            metadata: {
              project_key: issue.fields.project.key,
              issue_type: issue.fields.issuetype.name,
              status: issue.fields.status.name,
              priority: issue.fields.priority?.name,
              assignee: issue.fields.assignee?.displayName,
              labels: issue.fields.labels || [],
              created: issue.fields.created,
              updated: issue.fields.updated
            },
            business_context: {
              platform: "jira",
              entity_type: "issue",
              parent_project: issue.fields.project.key
            }
          };
        `
      }
    },
    {
      "name": "Send to Clario",
      "type": "n8n-nodes-base.httpRequest",
      "parameters": {
        "url": "http://localhost:8080/api/clario/ingest",
        "method": "POST",
        "headers": {
          "Content-Type": "application/json"
        },
        "body": "={{ $json }}"
      }
    }
  ]
}
```

### **2. Notion Pages Workflow**

```json
{
  "name": "Notion to Clario Sync",
  "nodes": [
    {
      "name": "Notion Trigger",
      "type": "n8n-nodes-base.notionTrigger",
      "parameters": {
        "event": "pageUpdated",
        "databaseId": "your-database-id"
      }
    },
    {
      "name": "Get Page Content",
      "type": "n8n-nodes-base.notion",
      "parameters": {
        "operation": "getPage",
        "pageId": "={{ $json.id }}"
      }
    },
    {
      "name": "Transform Notion Data",
      "type": "n8n-nodes-base.code",
      "parameters": {
        "code": `
          const page = $input.item.json;
          const blocks = page.blocks || [];
          
          // Extract text content from blocks
          let content = blocks
            .filter(block => block.type === 'paragraph')
            .map(block => block.paragraph?.rich_text?.[0]?.plain_text || '')
            .join('\\n\\n');
          
          return {
            platform: "notion",
            entity_type: "page",
            entity_id: page.id,
            title: page.properties?.title?.title?.[0]?.plain_text || 'Untitled',
            content: content,
            url: page.url,
            metadata: {
              workspace: page.parent?.workspace || 'unknown',
              created_time: page.created_time,
              last_edited_time: page.last_edited_time,
              created_by: page.created_by?.name,
              properties: page.properties
            },
            business_context: {
              platform: "notion",
              entity_type: "page",
              workspace: page.parent?.workspace
            }
          };
        `
      }
    },
    {
      "name": "Send to Clario",
      "type": "n8n-nodes-base.httpRequest",
      "parameters": {
        "url": "http://localhost:8080/api/clario/ingest",
        "method": "POST"
      }
    }
  ]
}
```

### **3. Slack Messages Workflow**

```json
{
  "name": "Slack to Clario Sync",
  "nodes": [
    {
      "name": "Slack Trigger",
      "type": "n8n-nodes-base.slackTrigger",
      "parameters": {
        "events": ["message"],
        "channels": ["#support", "#engineering", "#product"]
      }
    },
    {
      "name": "Filter Important Messages",
      "type": "n8n-nodes-base.filter",
      "parameters": {
        "conditions": {
          "string": [
            {
              "value1": "={{ $json.text }}",
              "operation": "contains",
              "value2": "bug|issue|problem|error|help"
            }
          ]
        }
      }
    },
    {
      "name": "Transform Slack Data",
      "type": "n8n-nodes-base.code",
      "parameters": {
        "code": `
          const message = $input.item.json;
          
          return {
            platform: "slack",
            entity_type: "message",
            entity_id: message.ts,
            title: \`Message in #\${message.channel.name}\`,
            content: message.text,
            url: \`https://company.slack.com/archives/\${message.channel.id}/p\${message.ts}\`,
            metadata: {
              channel_name: message.channel.name,
              user_name: message.user.name,
              timestamp: message.ts,
              thread_ts: message.thread_ts,
              reactions: message.reactions || []
            },
            business_context: {
              platform: "slack",
              entity_type: "message",
              channel: message.channel.name
            }
          };
        `
      }
    },
    {
      "name": "Send to Clario",
      "type": "n8n-nodes-base.httpRequest",
      "parameters": {
        "url": "http://localhost:8080/api/clario/ingest"
      }
    }
  ]
}
```

## 🔧 **Clario Ingestion API**

```python
# extensions/n8n_integration/ingestion_api.py
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field
from typing import Dict, Any, List
import uuid
from datetime import datetime

# Import Archon's processing pipeline
from extensions.business_connectors.base_connector import BusinessConnector

class N8NDataIngestion(BaseModel):
    """Standardized data format from n8n workflows"""
    platform: str = Field(..., description="Source platform (jira, notion, slack, etc.)")
    entity_type: str = Field(..., description="Type of entity (issue, page, message, etc.)")
    entity_id: str = Field(..., description="Unique ID from source platform")
    title: str = Field(..., description="Human-readable title")
    content: str = Field(default="", description="Main content text")
    url: str = Field(..., description="Link to original item")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Platform-specific metadata")
    business_context: Dict[str, Any] = Field(default_factory=dict, description="Business intelligence context")


class ArchonIngestionProcessor(BusinessConnector):
    """Process n8n data through Archon's pipeline"""
    
    def __init__(self, supabase_client=None):
        super().__init__("n8n_ingestion", {}, supabase_client)
    
    async def process_n8n_data(self, data: N8NDataIngestion) -> Dict[str, Any]:
        """Process n8n data through Archon's proven pipeline"""
        
        # Convert n8n format to internal format
        item = {
            "type": data.entity_type,
            "id": data.entity_id,
            "title": data.title,
            "content": data.content,
            "url": data.url,
            "platform": data.platform,
            **data.metadata,
            "business_metadata": data.business_context
        }
        
        # Use Archon's processing pipeline
        result = await self.process_with_archon_pipeline([item])
        
        return {
            "processed": True,
            "items_processed": result.get("items_processed", 1),
            "archon_result": result
        }


# Create API router
def create_n8n_router():
    router = APIRouter()
    processor = ArchonIngestionProcessor()
    
    @router.post("/ingest")
    async def ingest_from_n8n(
        data: N8NDataIngestion, 
        background_tasks: BackgroundTasks
    ):
        """
        Ingest data from n8n workflows into Clario/Archon pipeline.
        This is the endpoint that n8n workflows call.
        """
        try:
            # Validate data
            if not data.platform or not data.entity_type:
                raise HTTPException(status_code=400, detail="Platform and entity_type required")
            
            # Process in background for better n8n performance
            ingestion_id = str(uuid.uuid4())
            background_tasks.add_task(
                _process_ingestion_background,
                processor, data, ingestion_id
            )
            
            return {
                "success": True,
                "ingestion_id": ingestion_id,
                "platform": data.platform,
                "entity_type": data.entity_type,
                "entity_id": data.entity_id,
                "status": "queued_for_processing",
                "message": f"Data from {data.platform} queued for Archon processing"
            }
            
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Ingestion failed: {str(e)}")
    
    @router.post("/ingest/batch")
    async def ingest_batch_from_n8n(
        data_list: List[N8NDataIngestion],
        background_tasks: BackgroundTasks
    ):
        """Batch ingestion for efficient processing"""
        
        batch_id = str(uuid.uuid4())
        background_tasks.add_task(
            _process_batch_background,
            processor, data_list, batch_id
        )
        
        return {
            "success": True,
            "batch_id": batch_id,
            "items_queued": len(data_list),
            "status": "queued_for_processing"
        }
    
    return router


async def _process_ingestion_background(
    processor: ArchonIngestionProcessor, 
    data: N8NDataIngestion, 
    ingestion_id: str
):
    """Background processing of n8n data"""
    try:
        result = await processor.process_n8n_data(data)
        print(f"[{ingestion_id}] Processed {data.platform} {data.entity_type}: {result}")
        
    except Exception as e:
        print(f"[{ingestion_id}] Processing failed: {e}")


async def _process_batch_background(
    processor: ArchonIngestionProcessor,
    data_list: List[N8NDataIngestion],
    batch_id: str
):
    """Background processing of batch data"""
    try:
        for data in data_list:
            await processor.process_n8n_data(data)
            
        print(f"[{batch_id}] Batch processed: {len(data_list)} items")
        
    except Exception as e:
        print(f"[{batch_id}] Batch processing failed: {e}")
```

## 🎯 **Benefits of n8n Approach**

### ✅ **Development Speed**
- **Weeks instead of months**: No custom API integrations to build
- **400+ platforms available**: Jira, Notion, Slack, GitHub, Linear, Asana, etc.
- **Visual configuration**: Non-developers can set up integrations
- **Pre-built authentication**: OAuth, API keys all handled

### ✅ **Enterprise Features**  
- **Real-time webhooks**: Instant updates when data changes
- **Error handling**: Built-in retry logic and failure notifications
- **Rate limiting**: Automatic API rate limit handling
- **Monitoring**: Built-in workflow monitoring and logging

### ✅ **Maintainability**
- **No API maintenance**: n8n handles API changes and updates
- **Visual debugging**: See exactly where workflows fail
- **Version control**: Workflows can be exported/imported
- **Community support**: Large community creating workflow templates

### ✅ **Scalability**
- **Horizontal scaling**: n8n can run multiple instances
- **Queue management**: Built-in job queuing and processing
- **Performance optimization**: Batch processing, caching, etc.

## 🚀 **Implementation Timeline**

### **Week 1: n8n Setup + Jira**
```bash
# Install n8n
docker run -it --rm --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n n8nio/n8n

# Create Jira workflow
# Test data flow to Clario ingestion API
# Verify Archon processing works
```

### **Week 2: Add Notion + Slack**  
```bash
# Create Notion workflow
# Create Slack workflow
# Test batch ingestion
# Verify unified search works
```

### **Week 3: Founder Integration**
```bash
# Connect Founder frontend to Clario API  
# Test universal search in command palette
# Test AI Q&A with multi-platform context
# Add real-time updates via webhooks
```

## 🔮 **Advanced Features**

### **Conditional Processing**
```json
{
  "name": "Smart Filtering",
  "type": "n8n-nodes-base.if",
  "parameters": {
    "conditions": {
      "string": [
        {
          "value1": "={{ $json.fields.priority.name }}",
          "operation": "equal",
          "value2": "Critical"
        }
      ]
    }
  }
}
```

### **Cross-Platform Relationship Detection**
```json
{
  "name": "Find Related Content", 
  "type": "n8n-nodes-base.code",
  "parameters": {
    "code": `
      // Extract mentions of other platforms
      const text = $input.item.json.content.toLowerCase();
      
      const relationships = [];
      
      // Find Jira ticket references
      const jiraMatches = text.match(/[A-Z]+-\\d+/g);
      if (jiraMatches) {
        relationships.push({
          type: 'references',
          platform: 'jira',
          entities: jiraMatches
        });
      }
      
      // Find GitHub references
      const githubMatches = text.match(/#\\d+/g);
      if (githubMatches) {
        relationships.push({
          type: 'references', 
          platform: 'github',
          entities: githubMatches
        });
      }
      
      return {
        ...$input.item.json,
        relationships
      };
    `
  }
}
```

## ✅ **This Changes Everything**

**With n8n, Clario becomes:**
- ✅ **Rapid deployment**: Working integrations in days, not months
- ✅ **Enterprise ready**: 400+ platforms, real-time updates, error handling  
- ✅ **User configurable**: Non-technical users can add new platforms
- ✅ **Highly maintainable**: No custom API code to maintain
- ✅ **Infinitely extensible**: Any platform n8n supports becomes available

**The result: Founder becomes a company-wide AI assistant powered by ALL your business tools, delivered faster than ever before.**
