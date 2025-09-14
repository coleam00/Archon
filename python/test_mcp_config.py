#!/usr/bin/env python3
"""
Test script to verify MCP server configuration for Azure deployment
"""

import os
import sys
from pathlib import Path

# Add the project root to Python path
sys.path.insert(0, str(Path(__file__).resolve().parent))

def test_environment_detection():
    """Test environment detection"""
    print("🔍 Testing Environment Detection...")
    
    # Set Azure environment variables
    os.environ["CONTAINER_ENV"] = "azure"
    os.environ["DEPLOYMENT_MODE"] = "cloud"
    os.environ["ARCHON_SERVER_PORT"] = "8181"
    os.environ["ARCHON_MCP_PORT"] = "8051"
    os.environ["ARCHON_AGENTS_PORT"] = "8052"
    
    try:
        from src.server.config.service_discovery import get_discovery, Environment
        
        discovery = get_discovery()
        print(f"✓ Environment detected: {discovery.environment}")
        print(f"✓ Is Azure: {discovery.is_azure}")
        print(f"✓ Is Docker: {discovery.is_docker}")
        print(f"✓ Is Local: {discovery.is_local}")
        
        return True
    except Exception as e:
        print(f"✗ Environment detection failed: {e}")
        return False

def test_service_urls():
    """Test service URL generation"""
    print("\n🌐 Testing Service URL Generation...")
    
    try:
        from src.server.config.service_discovery import get_discovery
        
        discovery = get_discovery()
        
        # Test API URL
        api_url = discovery.get_service_url("api")
        print(f"✓ API URL: {api_url}")
        
        # Test MCP URL
        mcp_url = discovery.get_service_url("mcp")
        print(f"✓ MCP URL: {mcp_url}")
        
        # Test Agents URL
        agents_url = discovery.get_service_url("agents")
        print(f"✓ Agents URL: {agents_url}")
        
        return True
    except Exception as e:
        print(f"✗ Service URL generation failed: {e}")
        return False

def test_mcp_service_client():
    """Test MCP service client initialization"""
    print("\n🔧 Testing MCP Service Client...")
    
    try:
        from src.server.services.mcp_service_client import get_mcp_service_client
        
        client = get_mcp_service_client()
        print(f"✓ MCP Service Client initialized")
        print(f"✓ API URL: {client.api_url}")
        print(f"✓ Agents URL: {client.agents_url}")
        print(f"✓ Timeout: {client.timeout}")
        
        return True
    except Exception as e:
        print(f"✗ MCP Service Client initialization failed: {e}")
        return False

def test_mcp_server_import():
    """Test MCP server import"""
    print("\n🚀 Testing MCP Server Import...")
    
    try:
        # This should work without errors
        import src.mcp.mcp_server
        print("✓ MCP server module imported successfully")
        
        # Check if health endpoints are available
        if hasattr(src.mcp.mcp_server, 'health_app'):
            print("✓ Health endpoints configured")
        else:
            print("⚠ Health endpoints not found")
            
        return True
    except Exception as e:
        print(f"✗ MCP server import failed: {e}")
        return False

def main():
    """Run all tests"""
    print("🧪 MCP Server Configuration Test Suite")
    print("=" * 50)
    
    tests = [
        test_environment_detection,
        test_service_urls,
        test_mcp_service_client,
        test_mcp_server_import
    ]
    
    passed = 0
    total = len(tests)
    
    for test in tests:
        try:
            if test():
                passed += 1
        except Exception as e:
            print(f"✗ Test {test.__name__} failed with exception: {e}")
    
    print("\n" + "=" * 50)
    print(f"📊 Test Results: {passed}/{total} tests passed")
    
    if passed == total:
        print("🎉 All tests passed! MCP server is properly configured.")
        return 0
    else:
        print("❌ Some tests failed. Please check the configuration.")
        return 1

if __name__ == "__main__":
    sys.exit(main())



