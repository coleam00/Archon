-- Migration: 009_add_provider_placeholders.sql
-- Description: Add placeholder API key rows for OpenRouter, Anthropic, and Grok
-- Version: 0.1.0
-- Author: Archon Team
-- Date: 2025

-- Insert provider API key placeholders (idempotent)
INSERT INTO archon_settings (key, encrypted_value, is_encrypted, category, description)
VALUES
    ('OPENROUTER_API_KEY', NULL, true, 'api_keys', 'OpenRouter API key for hosted community models. Get from: https://openrouter.ai/keys'),
    ('ANTHROPIC_API_KEY', NULL, true, 'api_keys', 'Anthropic API key for Claude models. Get from: https://console.anthropic.com/account/keys'),
    ('GROK_API_KEY', NULL, true, 'api_keys', 'Grok API key for xAI models. Get from: https://console.x.ai/')
ON CONFLICT (key) DO NOTHING;

-- Record migration application for tracking
INSERT INTO archon_migrations (version, migration_name)
VALUES ('0.1.0', '010_add_provider_placeholders')
ON CONFLICT (version, migration_name) DO NOTHING;
