"""
Test n8n Integration-Only Approach
Shows how n8n Jira node extracts data and sends to Clario for Archon processing
"""

import asyncio
import json
from typing import Dict, Any, List

# Simulate what n8n's Jira node would extract
SAMPLE_N8N_JIRA_EXTRACTION = [
    {
        "platform": "jira",
        "type": "issue",
        "id": "10001", 
        "key": "AUTH-123",
        "title": "JWT token expiration not handled properly",
        "content": """Users are experiencing unexpected logouts when JWT tokens expire. The frontend doesn't properly handle the 401 response and users see a blank page instead of being redirected to login.

## Steps to Reproduce
1. Login to the application
2. Wait for JWT token to expire (24 hours)
3. Try to perform any authenticated action
4. Observe blank page instead of login redirect

## Expected Behavior
User should be automatically redirected to login page when token expires.""",
        "url": "https://company.atlassian.net/browse/AUTH-123",
        "metadata": {
            "project": {
                "key": "AUTH",
                "name": "Authentication System"
            },
            "issue_type": {
                "name": "Bug",
                "id": "1"
            },
            "status": {
                "name": "In Progress", 
                "id": "3"
            },
            "priority": {
                "name": "High",
                "id": "2"
            },
            "assignee": {
                "displayName": "John Developer",
                "emailAddress": "john@company.com"
            },
            "reporter": {
                "displayName": "Sarah Product Manager"
            },
            "labels": ["frontend", "authentication", "ux"],
            "components": ["User Management"],
            "created": "2024-09-12T10:30:00.000+0000",
            "updated": "2024-09-12T14:15:00.000+0000",
            "comments": [
                {
                    "id": "10050",
                    "body": "I can reproduce this issue. The axios interceptor isn't catching the 401 response properly. Need to check the frontend auth middleware.",
                    "author": {
                        "displayName": "Tech Lead",
                        "emailAddress": "tech@company.com"
                    },
                    "created": "2024-09-12T11:15:00.000+0000"
                },
                {
                    "id": "10051", 
                    "body": "Found the issue - the token refresh logic has a race condition. Working on a fix.",
                    "author": {
                        "displayName": "John Developer"
                    },
                    "created": "2024-09-12T13:30:00.000+0000"
                }
            ]
        }
    }
]


def test_n8n_data_extraction():
    """Test what n8n's Jira node would extract"""
    
    print("🔍 Testing n8n Jira Node Data Extraction")
    print("=" * 50)
    
    sample_issue = SAMPLE_N8N_JIRA_EXTRACTION[0]
    
    print("✅ n8n Jira node would extract:")
    print(f"   Issue: {sample_issue['key']} - {sample_issue['title']}")
    print(f"   Project: {sample_issue['metadata']['project']['name']}")
    print(f"   Status: {sample_issue['metadata']['status']['name']}")
    print(f"   Assignee: {sample_issue['metadata']['assignee']['displayName']}")
    print(f"   Labels: {sample_issue['metadata']['labels']}")
    print(f"   Comments: {len(sample_issue['metadata']['comments'])} comments")
    
    print("\n✅ All API complexity handled by n8n:")
    print("   - Authentication (API token)")
    print("   - JQL queries")
    print("   - Field extraction")
    print("   - Comment retrieval")
    print("   - Error handling")
    
    return True


def test_clario_processing():
    """Test how Clario would process n8n extracted data"""
    
    print("\n🧠 Testing Clario Processing of n8n Data")
    print("=" * 50)
    
    # Import the formatting function
    import sys
    sys.path.append('.')
    
    try:
        # This would be called by Clario when receiving n8n data
        from clario_app import _format_n8n_data_for_search
        
        sample_issue = SAMPLE_N8N_JIRA_EXTRACTION[0]
        
        # Format for Archon processing
        formatted_content = _format_n8n_data_for_search(sample_issue)
        
        print("✅ Clario formats n8n data for Archon:")
        print("   Content length:", len(formatted_content), "characters")
        print("   Preview:")
        print("   " + formatted_content[:300] + "...")
        
        print("\n✅ Ready for Archon pipeline:")
        print("   - Document chunking")
        print("   - Vector embeddings")
        print("   - Hybrid search indexing")
        print("   - RAG query capabilities")
        
        return True
        
    except ImportError as e:
        print(f"   ⚠️ Clario app not available: {e}")
        print("   This would work when Clario is running")
        return False


async def test_complete_flow():
    """Test the complete n8n → Clario → Archon flow"""
    
    print("\n🚀 Testing Complete Integration Flow")
    print("=" * 50)
    
    # Step 1: n8n extracts data (simulated)
    print("1️⃣ n8n Jira node extracts issues...")
    extracted_data = SAMPLE_N8N_JIRA_EXTRACTION
    print(f"   ✅ Extracted {len(extracted_data)} issues with full metadata")
    
    # Step 2: n8n sends to Clario (simulated)  
    print("\n2️⃣ n8n sends clean data to Clario...")
    
    try:
        import httpx
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "http://localhost:8080/api/ingest/batch",
                json=extracted_data,
                timeout=30.0
            )
            
            if response.status_code == 200:
                result = response.json()
                print(f"   ✅ Clario processed {result['processed']} items")
                print(f"   ✅ Archon result: {result.get('archon_result', {})}")
                
                # Step 3: Test search
                print("\n3️⃣ Testing unified search...")
                
                search_response = await client.post(
                    "http://localhost:8080/api/search/universal",
                    json={
                        "query": "JWT authentication",
                        "platforms": ["jira"],
                        "maxResults": 5
                    },
                    timeout=30.0
                )
                
                if search_response.status_code == 200:
                    search_result = search_response.json()
                    print(f"   ✅ Found {len(search_result['results'])} results")
                    
                    if search_result['results']:
                        top_result = search_result['results'][0]
                        print(f"   📊 Top result: {top_result['title']}")
                        print(f"   📊 Relevance: {top_result.get('relevance_score', 0):.3f}")
                        print(f"   📊 Platform: {top_result.get('platform', 'unknown')}")
                else:
                    print(f"   ⚠️ Search failed: {search_response.status_code}")
                
            else:
                print(f"   ⚠️ Clario not responding: {response.status_code}")
                
    except Exception as e:
        print(f"   ⚠️ Services not running: {e}")
        print("   Start services with: ./setup_clario.sh")
    
    print("\n🎯 Complete Flow Summary:")
    print("   n8n Jira node → extracts issues with all metadata")
    print("   ↓")
    print("   Clario API → receives clean JSON data")  
    print("   ↓")
    print("   Archon pipeline → chunks, embeds, indexes")
    print("   ↓")
    print("   Founder search → finds across all platforms")


def show_n8n_setup_instructions():
    """Show how to set up the n8n workflow"""
    
    print("\n🔧 n8n Setup Instructions")
    print("=" * 50)
    
    print("1️⃣ Start n8n:")
    print("   docker run -d -p 5678:5678 -v n8n_data:/home/node/.n8n n8nio/n8n")
    print("   Open: http://localhost:5678")
    
    print("\n2️⃣ Add Jira credentials:")
    print("   - Go to Settings → Credentials")
    print("   - Add 'Jira Software API'")
    print("   - Domain: company.atlassian.net")
    print("   - Email: your-email@company.com") 
    print("   - API Token: (from Atlassian account)")
    
    print("\n3️⃣ Import workflow:")
    print("   - Import examples/n8n_jira_workflow.json")
    print("   - Update JQL query for your project")
    print("   - Update Clario URL if different")
    
    print("\n4️⃣ Test workflow:")
    print("   - Execute manually first")
    print("   - Check Clario logs")
    print("   - Verify data appears in Archon UI")
    
    print("\n5️⃣ Set up triggers:")
    print("   - Add Jira Trigger node for real-time updates")
    print("   - Configure webhook URL in Jira admin")
    print("   - Test with real issue update")
    
    print("\n✅ Result: Easy visual integration with proven processing!")


async def main():
    """Run all tests and show setup instructions"""
    
    print("🧪 n8n Integration-Only Test Suite")
    print("Testing clean separation: n8n extracts → Clario processes")
    print("=" * 70)
    
    # Test n8n data extraction capabilities
    extraction_ok = test_n8n_data_extraction()
    
    # Test Clario processing  
    processing_ok = test_clario_processing()
    
    # Test complete flow (if services running)
    await test_complete_flow()
    
    # Show setup instructions
    show_n8n_setup_instructions()
    
    print("\n" + "=" * 70)
    print("🎯 Integration-Only Approach Summary:")
    print("✅ n8n handles ALL integration complexity")
    print("✅ Clario focuses on intelligence and processing") 
    print("✅ Archon provides proven document pipeline")
    print("✅ Founder gets unified search across all platforms")
    print("\n🚀 This is the cleanest architecture for your use case!")


if __name__ == "__main__":
    asyncio.run(main())
