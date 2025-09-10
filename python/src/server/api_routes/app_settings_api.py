"""
Application Settings API

Handles application configuration settings that are not part of the provider_clean system.
These are stored in the archon_settings table and include RAG strategy flags.
"""

import logging
import os
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from typing import Dict, Any

logger = logging.getLogger(__name__)

# Create router
router = APIRouter(prefix="/api", tags=["app-settings"])


async def get_settings_from_database() -> Dict[str, Any]:
    """Get settings from the archon_settings table."""
    try:
        from ..services.client_manager import get_supabase_client
        
        client = get_supabase_client()
        result = client.table("archon_settings").select("key, value, encrypted_value, is_encrypted").execute()
        
        settings = {}
        for row in result.data:
            key = row["key"]
            if row["is_encrypted"] and row["encrypted_value"]:
                # For encrypted values, we'd need to decrypt here
                # For now, skip encrypted values as they're likely API keys handled by provider_clean
                continue
            else:
                settings[key] = row["value"]
                
        return settings
        
    except Exception as e:
        logger.error(f"Error getting settings from database: {e}")
        return {}


@router.get("/app-settings")
async def get_app_settings():
    """Get application configuration settings."""
    try:
        settings = await get_settings_from_database()
        
        # Provide sensible defaults for missing settings
        defaults = {
            "USE_CONTEXTUAL_EMBEDDINGS": "false",
            "CONTEXTUAL_EMBEDDINGS_MAX_WORKERS": "3",
            "USE_HYBRID_SEARCH": "true", 
            "USE_AGENTIC_RAG": "true",
            "USE_RERANKING": "false",
            "CRAWL_BATCH_SIZE": "5",
            "CRAWL_MAX_CONCURRENT": "3",
            "CRAWL_WAIT_STRATEGY": "adaptive",
            "CRAWL_PAGE_TIMEOUT": "30000",
            "CRAWL_DELAY_BEFORE_HTML": "1000",
            "DOCUMENT_STORAGE_BATCH_SIZE": "50",
            "EMBEDDING_BATCH_SIZE": "100",
            "DELETE_BATCH_SIZE": "50",
            "ENABLE_PARALLEL_BATCHES": "true",
            "MEMORY_THRESHOLD_PERCENT": "80",
            "DISPATCHER_CHECK_INTERVAL": "5000",
            "CODE_EXTRACTION_BATCH_SIZE": "10",
            "CODE_SUMMARY_MAX_WORKERS": "3",
            "PROJECTS_ENABLED": "true",
            "DISCONNECT_SCREEN_ENABLED": "false"
        }
        
        # Merge database settings with defaults
        final_settings = {**defaults, **settings}
        
        return final_settings
        
    except Exception as e:
        logger.error(f"Error getting app settings: {e}")
        raise HTTPException(status_code=500, detail="Failed to get app settings")


@router.get("/app-settings/rag-strategy")
async def get_rag_strategy_settings():
    """Get RAG strategy specific settings for compatibility."""
    try:
        all_settings = await get_app_settings()
        
        # Get provider info from provider_clean system
        provider_settings = {}
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                # Get LLM service
                server_port = os.getenv("ARCHON_SERVER_PORT", "8181")
                llm_response = await client.get(f"http://localhost:{server_port}/api/providers/services/llm_primary")
                if llm_response.status_code == 200:
                    llm_service = llm_response.json()
                    default_model = llm_service.get("default_model", "")
                    if ":" in default_model:
                        provider, model = default_model.split(":", 1)
                        provider_settings["LLM_PROVIDER"] = provider
                        provider_settings["MODEL_CHOICE"] = model
                
                # Get embedding service  
                embed_response = await client.get(f"http://localhost:{server_port}/api/providers/services/embedding")
                if embed_response.status_code == 200:
                    embed_service = embed_response.json()
                    default_model = embed_service.get("default_model", "")
                    if ":" in default_model:
                        provider, model = default_model.split(":", 1)
                        provider_settings["EMBEDDING_MODEL"] = model
                        
        except Exception as e:
            logger.warning(f"Could not get provider settings: {e}")
        
        # Combine app settings with provider settings
        rag_settings = {**all_settings, **provider_settings}
        
        return rag_settings
        
    except Exception as e:
        logger.error(f"Error getting RAG strategy settings: {e}")
        raise HTTPException(status_code=500, detail="Failed to get RAG strategy settings")


@router.get("/app-settings/code-extraction")
async def get_code_extraction_settings():
    """Get code extraction specific settings."""
    try:
        all_settings = await get_app_settings()
        
        # Extract code extraction related settings
        code_settings = {
            "CODE_EXTRACTION_BATCH_SIZE": all_settings.get("CODE_EXTRACTION_BATCH_SIZE", "10"),
            "CODE_SUMMARY_MAX_WORKERS": all_settings.get("CODE_SUMMARY_MAX_WORKERS", "3")
        }
        
        return code_settings
        
    except Exception as e:
        logger.error(f"Error getting code extraction settings: {e}")
        raise HTTPException(status_code=500, detail="Failed to get code extraction settings")


@router.post("/app-settings/{key}")
async def update_app_setting(key: str, value: str):
    """Update an application setting."""
    try:
        from ..services.client_manager import get_supabase_client
        
        client = get_supabase_client()
        
        # First try to update existing record
        update_result = client.table("archon_settings").update({
            "value": value,
            "is_encrypted": False
        }).eq("key", key).execute()
        
        # If no rows were updated, insert new record
        if not update_result.data:
            insert_result = client.table("archon_settings").insert({
                "key": key,
                "value": value,
                "is_encrypted": False
            }).execute()
        
        return {"success": True, "key": key, "value": value}
        
    except Exception as e:
        logger.error(f"Error updating app setting {key}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to update setting: {key}")
