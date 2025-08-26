#!/usr/bin/env python3
"""
Validation script to check the deepseek model compatibility fix.
"""

def validate_ollama_api_fixes():
    """Validate that the fixes are properly implemented."""
    import ast
    
    # Read the modified file
    with open('/home/john/Archon/python/src/server/api_routes/ollama_api.py', 'r') as f:
        content = f.read()
    
    # Parse the AST to check for syntax errors
    try:
        ast.parse(content)
        print("✓ Syntax validation passed")
    except SyntaxError as e:
        print(f"✗ Syntax error: {e}")
        return False
    
    # Check that deepseek was removed from hardcoded partial support patterns
    lines = content.split('\n')
    for i, line in enumerate(lines):
        if "partial_support_patterns = [" in line:
            # Check the next few lines until the closing bracket
            bracket_count = line.count('[') - line.count(']')
            j = i + 1
            pattern_lines = [line]
            
            while j < len(lines) and bracket_count > 0:
                pattern_lines.append(lines[j])
                bracket_count += lines[j].count('[') - lines[j].count(']')
                j += 1
            
            # Join the pattern definition lines and check for deepseek
            pattern_def = '\n'.join(pattern_lines)
            if "'deepseek'" in pattern_def and "#" not in pattern_def.split("'deepseek'")[0].split('\n')[-1]:
                print("✗ Found deepseek still hardcoded in partial_support_patterns")
                return False
    
    print("✓ Deepseek removed from hardcoded patterns")
    
    # Check that new testing functions exist
    required_functions = [
        '_test_function_calling_capability',
        '_test_structured_output_capability',
        'test_model_capabilities_endpoint'
    ]
    
    for func in required_functions:
        if func not in content:
            print(f"✗ Missing required function: {func}")
            return False
        else:
            print(f"✓ Found function: {func}")
    
    # Check that new endpoint exists
    if '/models/test-capabilities' not in content:
        print("✗ Missing new endpoint: /models/test-capabilities")
        return False
    
    print("✓ New capability testing endpoint found")
    
    # Check model capability classes
    required_classes = ['ModelCapabilityTestRequest', 'ModelCapabilityTestResponse']
    for cls in required_classes:
        if cls not in content:
            print(f"✗ Missing required class: {cls}")
            return False
        else:
            print(f"✓ Found class: {cls}")
    
    return True

def validate_model_discovery_service_fixes():
    """Validate that the model discovery service has been updated."""
    
    with open('/home/john/Archon/python/src/server/services/ollama/model_discovery_service.py', 'r') as f:
        content = f.read()
    
    # Check that new capabilities were added to ModelCapabilities
    if 'supports_function_calling: bool = False' not in content:
        print("✗ Missing supports_function_calling in ModelCapabilities")
        return False
    
    if 'supports_structured_output: bool = False' not in content:
        print("✗ Missing supports_structured_output in ModelCapabilities")
        return False
    
    print("✓ New capability fields added to ModelCapabilities")
    
    # Check that new testing methods exist
    required_methods = [
        '_test_function_calling_capability',
        '_test_structured_output_capability'
    ]
    
    for method in required_methods:
        if method not in content:
            print(f"✗ Missing method in model discovery service: {method}")
            return False
        else:
            print(f"✓ Found method in model discovery service: {method}")
    
    return True

def validate_provider_discovery_service_fixes():
    """Validate provider discovery service updates."""
    
    with open('/home/john/Archon/python/src/server/services/provider_discovery_service.py', 'r') as f:
        content = f.read()
    
    # Check that _test_tool_support method exists
    if '_test_tool_support' not in content:
        print("✗ Missing _test_tool_support method in provider discovery service")
        return False
    
    print("✓ Found _test_tool_support method in provider discovery service")
    
    # Check that the hardcoded tool support detection was replaced with testing
    if 'await self._test_tool_support(model_name, api_url)' not in content:
        print("✗ Tool support testing not integrated into model discovery")
        return False
    
    print("✓ Tool support testing integrated into model discovery")
    
    return True

if __name__ == "__main__":
    print("Validating deepseek model compatibility fixes...\n")
    
    print("1. Validating ollama_api.py fixes:")
    api_valid = validate_ollama_api_fixes()
    
    print("\n2. Validating model_discovery_service.py fixes:")
    discovery_valid = validate_model_discovery_service_fixes()
    
    print("\n3. Validating provider_discovery_service.py fixes:")
    provider_valid = validate_provider_discovery_service_fixes()
    
    if api_valid and discovery_valid and provider_valid:
        print("\n🎉 All fixes validated successfully!")
        print("\nSUMMARY:")
        print("- Removed deepseek from hardcoded partial support patterns")
        print("- Added real function calling capability testing")
        print("- Added real structured output capability testing")
        print("- Created new endpoint for real-time model capability testing")
        print("- Enhanced model discovery services with actual API testing")
        print("\nDeeseek models will now be tested for actual capabilities rather than assumed to have partial support.")
    else:
        print("\n❌ Some fixes failed validation!")
        exit(1)