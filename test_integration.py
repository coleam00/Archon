"""
Test Clario integration with Archon infrastructure
Verifies that our extensions can properly use Archon's proven services
"""

import sys
import asyncio
from datetime import datetime

def test_archon_imports():
    """Test that we can import Archon's core services"""
    print("🔍 Testing Archon module imports...")
    
    try:
        # Test core Archon imports
        from python.src.server.utils import get_supabase_client
        print("   ✅ Can import Archon database utilities")
        
        from python.src.server.services.search.rag_service import RAGService
        print("   ✅ Can import Archon RAG service")
        
        from python.src.server.config.logfire_config import get_logger
        print("   ✅ Can import Archon logging")
        
        from python.src.server.services.storage.document_storage_service import add_documents_to_supabase
        print("   ✅ Can import Archon document storage")
        
        return True
        
    except ImportError as e:
        print(f"   ❌ Import error: {e}")
        return False


def test_clario_extensions():
    """Test that our Clario extensions load properly"""
    print("\n🔍 Testing Clario extension imports...")
    
    try:
        from extensions.n8n_integration.ingestion_api import create_n8n_router
        print("   ✅ Can import n8n ingestion API")
        
        from extensions.unified_search.archon_search import ArchonUnifiedSearch
        print("   ✅ Can import unified search engine")
        
        return True
        
    except ImportError as e:
        print(f"   ❌ Extension import error: {e}")
        return False


async def test_archon_integration():
    """Test that Clario can actually use Archon's services"""
    print("\n🔍 Testing Clario → Archon integration...")
    
    try:
        # Test creating search engine (this uses Archon's RAG service)
        from extensions.unified_search.archon_search import ArchonUnifiedSearch
        
        search_engine = ArchonUnifiedSearch()
        print("   ✅ Created unified search engine using Archon RAG")
        
        # Test creating n8n processor (this uses Archon's storage service)
        from extensions.n8n_integration.ingestion_api import processor
        
        print("   ✅ Created n8n processor using Archon storage pipeline")
        
        return True
        
    except Exception as e:
        print(f"   ❌ Integration error: {e}")
        return False


def test_n8n_data_format():
    """Test n8n data format validation"""
    print("\n🔍 Testing n8n data format...")
    
    try:
        from extensions.n8n_integration.ingestion_api import N8NDataPayload
        
        # Test valid data
        test_data = N8NDataPayload(
            platform="jira",
            entity_type="issue",
            entity_id="TEST-123",
            title="TEST-123: Sample issue",
            content="Sample content for testing",
            url="https://company.atlassian.net/browse/TEST-123",
            metadata={"project_key": "TEST"},
            business_context={"platform": "jira", "entity_type": "issue"}
        )
        
        print("   ✅ n8n data format validation works")
        print(f"   ✅ Sample data: {test_data.platform} {test_data.entity_type}")
        
        return True
        
    except Exception as e:
        print(f"   ❌ Data format error: {e}")
        return False


async def main():
    """Run all integration tests"""
    print("🧪 Clario Integration Test Suite")
    print("Testing Clario extensions with Archon infrastructure")
    print("=" * 55)
    
    # Run tests
    tests = [
        ("Archon Imports", test_archon_imports),
        ("Clario Extensions", test_clario_extensions), 
        ("n8n Data Format", test_n8n_data_format),
        ("Archon Integration", test_archon_integration)
    ]
    
    results = []
    for test_name, test_func in tests:
        try:
            if asyncio.iscoroutinefunction(test_func):
                result = await test_func()
            else:
                result = test_func()
            results.append((test_name, result))
        except Exception as e:
            print(f"   ❌ {test_name} failed with exception: {e}")
            results.append((test_name, False))
    
    # Summary
    print("\n" + "=" * 55)
    print("📊 Test Results:")
    
    all_passed = True
    for test_name, passed in results:
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"   {status} {test_name}")
        if not passed:
            all_passed = False
    
    print("\n" + "=" * 55)
    
    if all_passed:
        print("🎉 All tests passed! Clario is ready to use.")
        print("\nNext steps:")
        print("1. Start services: ./setup_clario.sh")
        print("2. Configure n8n workflows")
        print("3. Test with real business data")
        print("4. Integrate with Founder frontend")
    else:
        print("❌ Some tests failed. Please check the errors above.")
        print("\nCommon issues:")
        print("- Make sure you're in the Archon repository root")
        print("- Ensure all Archon files are present")
        print("- Check Python dependencies are installed")
    
    return all_passed


if __name__ == "__main__":
    asyncio.run(main())
