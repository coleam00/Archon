"""
Simple Test: n8n Integration-Only Approach
Shows the clean separation without requiring full environment setup
"""

import json
from typing import Dict, Any, List


def simulate_n8n_jira_extraction():
    """Show exactly what n8n's Jira node would extract"""
    
    print("🔍 What n8n's Jira Node Extracts")
    print("=" * 40)
    
    # This is what n8n's Jira node actually outputs
    n8n_extracted_data = {
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
            "project": {"key": "AUTH", "name": "Authentication System"},
            "created": "2024-09-12T10:30:00.000+0000",
            "updated": "2024-09-12T14:15:00.000+0000",
            "labels": ["frontend", "authentication", "ux"],
            "components": [{"name": "User Management"}],
            "comment": {
                "total": 2,
                "comments": [
                    {
                        "id": "10050",
                        "body": "I can reproduce this issue. The axios interceptor isn't catching the 401 response properly.",
                        "author": {"displayName": "Tech Lead"},
                        "created": "2024-09-12T11:15:00.000+0000"
                    },
                    {
                        "id": "10051",
                        "body": "Found the issue - the token refresh logic has a race condition. Working on a fix.",
                        "author": {"displayName": "John Developer"},
                        "created": "2024-09-12T13:30:00.000+0000"
                    }
                ]
            }
        }
    }
    
    print("✅ n8n Jira node handles ALL the complexity:")
    print(f"   - Authentication: ✅ API token managed")
    print(f"   - JQL Query: ✅ 'project = AUTH AND updated >= -7d'")
    print(f"   - Field extraction: ✅ {len(n8n_extracted_data['fields'])} fields")
    print(f"   - Comments: ✅ {n8n_extracted_data['fields']['comment']['total']} comments")
    print(f"   - Error handling: ✅ Built-in retry logic")
    print(f"   - Rate limiting: ✅ Automatic throttling")
    
    print(f"\n📊 Rich data extracted:")
    print(f"   Issue: {n8n_extracted_data['key']} - {n8n_extracted_data['fields']['summary']}")
    print(f"   Project: {n8n_extracted_data['fields']['project']['name']}")
    print(f"   Status: {n8n_extracted_data['fields']['status']['name']}")
    print(f"   Assignee: {n8n_extracted_data['fields']['assignee']['displayName']}")
    print(f"   Labels: {n8n_extracted_data['fields']['labels']}")
    
    return n8n_extracted_data


def simulate_n8n_transformation():
    """Show how n8n would transform the data for Clario"""
    
    print("\n🔄 n8n Code Node Transformation")
    print("=" * 40)
    
    # Simulate n8n's Code node transformation
    n8n_code = """
    // This runs in n8n's Code node
    const issue = $input.item.json;
    const fields = issue.fields;
    
    return {
      platform: "jira",
      type: "issue", 
      id: issue.id,
      key: issue.key,
      title: fields.summary,
      content: fields.description || '',
      url: `https://company.atlassian.net/browse/${issue.key}`,
      
      metadata: {
        project: fields.project,
        issue_type: fields.issuetype,
        status: fields.status,
        priority: fields.priority,
        assignee: fields.assignee,
        labels: fields.labels || [],
        components: fields.components || [],
        created: fields.created,
        updated: fields.updated,
        comments: fields.comment?.comments || []
      }
    };
    """
    
    print("✅ n8n transforms to clean format:")
    print("   - Simple JSON structure")
    print("   - All metadata preserved") 
    print("   - Ready for Clario ingestion")
    print("   - No complex API handling needed")
    
    # Simulate the output
    transformed_data = {
        "platform": "jira",
        "type": "issue",
        "id": "10001",
        "key": "AUTH-123",
        "title": "JWT token expiration not handled properly",
        "content": "Users experiencing unexpected logouts when JWT tokens expire...",
        "url": "https://company.atlassian.net/browse/AUTH-123",
        "metadata": {
            "project": {"key": "AUTH", "name": "Authentication System"},
            "status": {"name": "In Progress"},
            "assignee": {"displayName": "John Developer"},
            "labels": ["frontend", "authentication", "ux"],
            "comments": [
                {"body": "I can reproduce this issue...", "author": {"displayName": "Tech Lead"}},
                {"body": "Found the issue - race condition...", "author": {"displayName": "John Developer"}}
            ]
        }
    }
    
    return transformed_data


def simulate_clario_processing(transformed_data):
    """Show how Clario would process the clean n8n data"""
    
    print("\n⚡ Clario Processing (via Archon)")
    print("=" * 40)
    
    # Show how Clario formats for search
    formatted_content = f"""# {transformed_data['key']}: {transformed_data['title']}
**Project:** {transformed_data['metadata']['project']['name']} ({transformed_data['metadata']['project']['key']})
**Type:** {transformed_data['metadata'].get('issue_type', {}).get('name', 'Issue')} | **Status:** {transformed_data['metadata']['status']['name']}
**Assignee:** {transformed_data['metadata']['assignee']['displayName']}
**Labels:** {', '.join(transformed_data['metadata']['labels'])}

## Description
{transformed_data['content']}

## Comments
**Tech Lead:** I can reproduce this issue...
**John Developer:** Found the issue - race condition...

**Source:** [View in Jira]({transformed_data['url']})"""
    
    print("✅ Clario formats for Archon pipeline:")
    print(f"   - Content length: {len(formatted_content)} characters")
    print(f"   - Searchable format: ✅")
    print(f"   - Rich metadata: ✅") 
    print(f"   - Source attribution: ✅")
    
    print(f"\n📄 Formatted content preview:")
    print("   " + formatted_content[:200] + "...")
    
    print(f"\n🧠 Then Archon processes:")
    print("   - Intelligent chunking")
    print("   - Vector embeddings") 
    print("   - Hybrid search indexing")
    print("   - RAG query capabilities")
    
    archon_metadata = {
        "integration_type": "jira",
        "content_type": "issue",
        "extracted_by": "n8n_jira_node",
        "business_metadata": transformed_data["metadata"],
        "issue_key": transformed_data["key"],
        "project_key": transformed_data["metadata"]["project"]["key"],
        "status": transformed_data["metadata"]["status"]["name"],
        "assignee": transformed_data["metadata"]["assignee"]["displayName"]
    }
    
    print(f"\n📊 Rich metadata for search:")
    for key, value in list(archon_metadata.items())[:5]:
        print(f"   {key}: {value}")
    print("   ...")
    
    return formatted_content


def show_founder_integration():
    """Show how this integrates with Founder"""
    
    print("\n🎯 Founder Integration")
    print("=" * 40)
    
    founder_code = """
// In Founder's command palette
const clario = new ClarioClient('http://localhost:8080');

// User searches: "auth bugs"
const results = await clario.universalSearch('auth bugs');

// Results from ALL platforms processed via Archon:
results = [
  {
    title: "AUTH-123: JWT token expiration not handled properly",
    platform: "jira",
    content_type: "issue", 
    relevance_score: 0.95,
    url: "https://company.atlassian.net/browse/AUTH-123",
    business_context: {
      project: "Authentication System",
      status: "In Progress",
      assignee: "John Developer"
    },
    founder_node_type: "task"  // Classified automatically
  }
];

// User asks: "?What auth issues have we had?"
const answer = await clario.askQuestion('What auth issues have we had?');

// AI response with full source attribution:
answer = {
  question: "What auth issues have we had?",
  answer: "Based on your Jira data, you've had 1 authentication issue...",
  sources: [
    {
      title: "AUTH-123: JWT token expiration issue",
      platform: "jira",
      relevance_score: 0.95,
      url: "https://company.atlassian.net/browse/AUTH-123"
    }
  ]
};
    """
    
    print("✅ Perfect integration with Founder:")
    print("   - Universal search across all platforms")
    print("   - AI Q&A with company context")
    print("   - Source attribution to original tools")
    print("   - Automatic classification into 4-node taxonomy")
    
    print(f"\n💡 User Experience:")
    print("   Cmd+K → 'auth bugs' → Shows Jira issues, GitHub PRs, Slack discussions")
    print("   Cmd+K → '?auth issues?' → AI summary with sources")
    print("   Click result → View in knowledge graph or original platform")


def main():
    """Run the complete demonstration"""
    
    print("🎯 Clean Integration Test: n8n → Clario → Archon")
    print("Testing perfect separation of concerns")
    print("=" * 60)
    
    # Step 1: What n8n extracts
    n8n_data = simulate_n8n_jira_extraction()
    
    # Step 2: How n8n transforms 
    transformed_data = simulate_n8n_transformation()
    
    # Step 3: How Clario processes
    formatted_content = simulate_clario_processing(transformed_data)
    
    # Step 4: How Founder integrates
    show_founder_integration()
    
    print("\n" + "=" * 60)
    print("🎉 Clean Integration Summary:")
    print("✅ n8n Jira node: Handles ALL integration complexity")
    print("✅ Clario API: Simple JSON ingestion → Archon processing")
    print("✅ Archon pipeline: Proven chunking, embeddings, search")
    print("✅ Founder UI: Universal search with source attribution")
    
    print(f"\n🚀 To implement:")
    print("1. Start n8n: docker run -p 5678:5678 n8nio/n8n") 
    print("2. Import workflow: examples/n8n_jira_workflow.json")
    print("3. Configure Jira credentials in n8n")
    print("4. Start Clario: python clario_app.py")
    print("5. Run workflow → Data flows: Jira → n8n → Clario → Archon")
    print("6. Search in Founder: instant results across all platforms!")


if __name__ == "__main__":
    main()
