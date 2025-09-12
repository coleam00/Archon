# Clean Integration: n8n Jira Node → Clario → Archon

## 🎯 **Perfect Separation of Concerns**

**n8n handles integration** → **Clario handles intelligence** → **Archon handles processing**

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│     Jira API    │    │  n8n Jira Node  │    │ Clario + Archon │
│                 │    │                 │    │                 │
│ Complex API     │───▶│ ✅ Pre-built    │───▶│ ✅ Proven       │
│ Authentication  │    │ ✅ Tested       │    │ ✅ Reliable     │
│ Rate Limits     │    │ ✅ Visual       │    │ ✅ Intelligent  │
│ Pagination      │    │ ✅ No Code      │    │ ✅ Searchable   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 🔧 **n8n Jira Node: What It Actually Does**

Based on research, n8n's Jira node is **excellent** for data extraction:

### **✅ Operations Available**
```javascript
// Get All Issues with JQL
{
  "resource": "issue",
  "operation": "getAll",
  "jql": "project = PROJ AND updated >= -30d",
  "fields": ["summary", "description", "status", "assignee", "comment"]
}

// Get Single Issue with Full Details  
{
  "resource": "issue", 
  "operation": "get",
  "issueKey": "PROJ-123",
  "expand": ["changelog", "renderedFields"]
}

// Get Issue Comments
{
  "resource": "issueComment",
  "operation": "getAll", 
  "issueKey": "PROJ-123"
}
```

### **✅ Authentication Handled**
```javascript
// n8n handles all authentication complexity
credentials: {
  "authenticationMethod": "apiToken",
  "email": "user@company.com",
  "apiToken": "ATATT3x...",
  "domain": "company.atlassian.net"
}
// No custom OAuth or token management needed!
```

### **✅ Data Extraction Example**

```json
// What n8n Jira node extracts (actual output):
[
  {
    "id": "10001",
    "key": "AUTH-123",
    "fields": {
      "summary": "JWT token expiration not handled properly",
      "description": "Users experiencing unexpected logouts when JWT tokens expire...",
      "issuetype": {"name": "Bug", "id": "1"},
      "status": {"name": "In Progress", "id": "3"},
      "priority": {"name": "High", "id": "2"},
      "assignee": {
        "displayName": "John Developer",
        "emailAddress": "john@company.com"
      },
      "reporter": {"displayName": "Sarah PM"},
      "project": {
        "key": "AUTH",
        "name": "Authentication System"
      },
      "created": "2024-09-12T10:30:00.000+0000",
      "updated": "2024-09-12T14:15:00.000+0000",
      "labels": ["frontend", "authentication", "bug"],
      "components": [{"name": "User Management"}],
      "comment": {
        "total": 3,
        "comments": [
          {
            "id": "10050",
            "body": "I can reproduce this issue. The axios interceptor isn't catching the 401 response properly.",
            "author": {"displayName": "Tech Lead"},
            "created": "2024-09-12T11:15:00.000+0000"
          }
        ]
      }
    }
  }
]
```

## 🚀 **Practical n8n Workflow**

### **Simple Jira → Clario Workflow**

```json
{
  "name": "Jira Issues to Clario",
  "description": "Extract Jira data using n8n's node, send to Clario for Archon processing",
  "nodes": [
    {
      "name": "Extract Jira Issues",
      "type": "n8n-nodes-base.jira",
      "parameters": {
        "resource": "issue",
        "operation": "getAll",
        "jql": "project = AUTH AND updated >= -7d",
        "additionalFields": {
          "fields": [
            "summary", "description", "issuetype", "status", "priority",
            "assignee", "reporter", "project", "created", "updated", 
            "labels", "components", "comment"
          ],
          "expand": ["changelog"]
        }
      },
      "credentials": {
        "jira": "your-jira-credentials"
      }
    },
    {
      "name": "Format for Clario",
      "type": "n8n-nodes-base.code", 
      "parameters": {
        "code": `
          // n8n extracted everything, just format for Clario
          const issues = $input.all();
          
          return issues.map(item => {
            const issue = item.json;
            const fields = issue.fields;
            
            return {
              // Simple format for Clario ingestion
              platform: "jira",
              type: "issue",
              id: issue.id,
              key: issue.key,
              title: fields.summary,
              content: fields.description || '',
              url: \`https://company.atlassian.net/browse/\${issue.key}\`,
              
              // All metadata n8n extracted
              metadata: {
                project: fields.project,
                issue_type: fields.issuetype,
                status: fields.status,
                priority: fields.priority,
                assignee: fields.assignee,
                reporter: fields.reporter,
                labels: fields.labels || [],
                components: fields.components || [],
                created: fields.created,
                updated: fields.updated,
                comments: fields.comment?.comments || []
              }
            };
          });
        `
      }
    },
    {
      "name": "Send to Clario",
      "type": "n8n-nodes-base.httpRequest",
      "parameters": {
        "url": "http://localhost:8080/api/ingest/batch",
        "method": "POST",
        "headers": {
          "Content-Type": "application/json"
        },
        "body": "={{ JSON.stringify($json) }}"
      }
    }
  ]
}
```

## ⚡ **Clario Ingestion API (Simplified)**

```python
# clario_app.py - Clean ingestion endpoint
@app.post("/api/ingest/batch")
async def ingest_batch(items: List[Dict[str, Any]]):
    """
    Receive clean data from n8n and process via Archon.
    n8n did the extraction, we do the intelligence.
    """
    
    processed_items = []
    
    for item in items:
        # Convert n8n data to Archon format
        archon_item = {
            "url": item["url"],
            "chunk_number": 0,
            "content": format_for_search(item),
            "metadata": {
                "integration_type": item["platform"],
                "content_type": item["type"],
                "extracted_by": "n8n_node",
                "business_context": item["metadata"],
                **item["metadata"]  # Include all n8n extracted metadata
            }
        }
        processed_items.append(archon_item)
    
    # Process through Archon's proven pipeline
    await process_through_archon_pipeline(processed_items)
    
    return {
        "success": True,
        "processed": len(items),
        "now_searchable": True
    }


def format_for_search(item: Dict[str, Any]) -> str:
    """Format n8n extracted data for optimal search"""
    
    metadata = item["metadata"]
    
    parts = [
        f"# {item['key']}: {item['title']}",
        f"**Project:** {metadata['project']['name']}",
        f"**Status:** {metadata['status']['name']}",
        f"**Assignee:** {metadata['assignee']['displayName'] if metadata.get('assignee') else 'Unassigned'}",
    ]
    
    if item.get("content"):
        parts.extend(["", "## Description", item["content"]])
    
    # Add comments if present
    if metadata.get("comments"):
        parts.append("\n## Comments")
        for comment in metadata["comments"][:3]:  # Latest 3
            author = comment.get("author", {}).get("displayName", "Unknown")
            parts.append(f"**{author}:** {comment.get('body', '')[:200]}...")
    
    parts.append(f"\n**Source:** [View in Jira]({item['url']})")
    
    return "\n".join(parts)
```

## 🎯 **What This Gives You**

### **For Each Platform:**

#### **Jira Integration**
```
n8n Jira Node → Extracts issues with full metadata
↓
Clario API → Formats for Archon processing  
↓
Archon Pipeline → Chunks, embeds, indexes
↓
Founder Search → "auth bugs" finds all related Jira issues
```

#### **Easy to Add More Platforms**
```
n8n Notion Node → Extract pages/databases
n8n Slack Node → Extract messages/threads  
n8n GitHub Node → Extract issues/PRs/code
All → Same Clario processing → Same unified search
```

## ✅ **Ready to Implement**

```bash
# 1. Start n8n
docker run -d -p 5678:5678 -v n8n_data:/home/node/.n8n n8nio/n8n

# 2. Open n8n UI
open http://localhost:5678

# 3. Create Jira workflow:
#    - Add "Jira Software" node  
#    - Operation: "Get All"
#    - JQL: "project = YOUR_PROJECT"
#    - Fields: summary, description, status, assignee, comment
#    - Add "HTTP Request" → http://localhost:8080/api/ingest/batch

# 4. Start Clario
python clario_app.py

# 5. Run workflow in n8n
# 6. Search in Founder: "your search term"
# 7. Get results across all connected platforms!
```

**This approach is perfect: leverage n8n's integration strength + Archon's processing strength = ideal architecture for your use case!**
