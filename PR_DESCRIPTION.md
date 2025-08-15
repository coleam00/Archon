# Feature: Add OpenRouter Support + Added EMBEDDING_PROVIDER Setting

## 🚀 New Feature: OpenRouter LLM Provider Support

**Added**: Full OpenRouter integration as an LLM provider option
- **Access**: 200+ models from multiple providers (Anthropic, OpenAI, Meta, Google, etc.)
- **UI Integration**: Added to provider dropdown in RAG Settings
- **Mixed Provider Support**: Use OpenRouter for LLM + OpenAI/Google/Ollama for embeddings
- **Documentation**: Updated user guides and configuration docs
- **Added**: `EMBEDDING_PROVIDER` setting to `migration/complete_setup.sql`
- **Default**: Set to `'openai'` for compatibility
- **Conflict Handling**: Uses `ON CONFLICT (key) DO NOTHING` for safe updates

### Backend Validation Enhancement
- **Added**: Provider value validation in `credential_service.py`
- **Added**: Auto-recovery logic to create missing `EMBEDDING_PROVIDER` setting
- **Added**: Fallback to safe defaults when invalid provider values detected

### Changes Made

#### 1. OpenRouter LLM Provider Support
- **Backend**: Added OpenRouter client creation in `llm_provider_service.py`
- **Frontend**: Added OpenRouter option to provider dropdown in RAG Settings
- **Configuration**: OpenRouter uses `https://openrouter.ai/api/v1` as base URL
- **Model Support**: Supports all OpenRouter-compatible models (anthropic/claude-3.5-sonnet, etc.)

#### 2. Database Migration (`migration/complete_setup.sql`)
```sql
-- Added line 97:
('EMBEDDING_PROVIDER', 'openai', false, 'rag_strategy', 'Embedding provider to use: openai, ollama, or google'),
```

#### 3. Enhanced Credential Service (`python/src/server/services/credential_service.py`)
- Enhanced `get_active_provider()` method with validation
- Added auto-creation of missing `EMBEDDING_PROVIDER` setting
- Added type checking to prevent boolean values being used as provider names

#### 4. Documentation Updates
- **RAG Documentation**: Added OpenRouter configuration section
- **Configuration Guide**: Updated provider setup instructions
- **Getting Started**: Updated to mention multiple provider options
- **README**: Updated feature list to include OpenRouter

## ✅ Testing

### Manual Testing
- [x] RAG operations complete successfully
- [x] Contextual embeddings work with OpenRouter LLM + OpenAI embeddings
- [x] No regression in existing functionality
- [x] Settings UI displays correctly

### Test Environment
- Docker environment: `docker-compose up --build -d`
- Tested crawling: https://docs.langchain.com/llms.txt
- Verified: Embedding creation succeeds without errors

## 🔄 Migration Notes

**For Existing Installations:**
1. **Automatic**: The credential service will auto-create the missing setting
2. **Manual**: Run the SQL from `complete_setup.sql` line 97
3. **No Breaking Changes**: Existing configurations remain unchanged

**For New Installations:**
- The `EMBEDDING_PROVIDER` setting will be created automatically during setup

## 📝 Documentation Impact

- **No user-facing documentation changes needed**
- **Internal**: Enhanced error handling and validation
- **Setup**: Improved database migration completeness

## 🎯 Verification Steps

To verify this fix works:

1. **Start fresh environment**: `docker-compose up --build -d`
2. **Configure providers**: Set LLM_PROVIDER to 'openrouter', EMBEDDING_PROVIDER to 'openai'
3. **Test RAG operation**: Crawl any documentation URL
4. **Verify success**: No "Unsupported LLM provider: false" errors

## 🔗 Related Issues

This fix resolves the embedding provider configuration gap that was causing RAG operations to fail when using mixed provider setups (e.g., OpenRouter for LLM + OpenAI for embeddings).

## 📋 Checklist

- [x] Code follows existing patterns and architecture
- [x] Database migration is safe and backwards compatible  
- [x] Error handling and validation added
- [x] Manual testing completed successfully
- [x] No breaking changes introduced
- [x] Commit message follows project guidelines
