#!/usr/bin/env python3
"""
Quick script to fix model types in stored Ollama models
"""

import json
import requests

def fix_model_types():
    # Get current stored models
    response = requests.get("http://localhost:8181/api/ollama/models/stored")
    if response.status_code != 200:
        print("Failed to get stored models")
        return
    
    data = response.json()
    models = data.get('models', [])
    
    print(f"Found {len(models)} models")
    
    # Fix phi4-mini variants that are incorrectly classified
    chat_model_patterns = [
        'phi4-mini-10k', 'phi4-mini-15k', 'phi4-mini-20k', 
        'phi4-mini', 'qwen', 'deepseek'
    ]
    
    updated = False
    for model in models:
        model_name = model.get('name', '').lower()
        current_type = model.get('model_type', '')
        
        # Check if this is a chat model that's misclassified
        for pattern in chat_model_patterns:
            if pattern in model_name and current_type != 'chat':
                print(f"Fixing {model['name']} from {current_type} to chat")
                model['model_type'] = 'chat'
                updated = True
                break
    
    if not updated:
        print("No models needed fixing")
        return
    
    # Update the stored models via the discover endpoint by directly modifying the archon_settings
    # This is a hack but faster than running full discovery
    
    from datetime import datetime
    import sys
    sys.path.append('/home/john/Archon/python/src')
    from server.utils import get_supabase_client
    
    try:
        supabase = get_supabase_client()
        
        models_data = {
            "models": models,
            "last_discovery": datetime.now().isoformat(),
            "instances_checked": 2,
            "total_count": len(models)
        }
        
        # Update the stored models
        result = supabase.table("archon_settings").upsert({
            "key": "ollama_discovered_models",
            "value": json.dumps(models_data),
            "category": "ollama",
            "description": "Discovered Ollama models with compatibility information",
            "updated_at": datetime.now().isoformat()
        }).execute()
        
        print("✅ Successfully updated model types in database")
        print(f"Updated {len(models)} models total")
        
    except Exception as e:
        print(f"❌ Failed to update database: {e}")

if __name__ == "__main__":
    fix_model_types()