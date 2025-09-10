# Database Migrations - Manual Execution Guide

**Note**: This directory previously contained local migration files, but all migrations have been consolidated into the main `../../../migration/` directory for better organization.

## 📋 Main Migration File

### `provider_feature_schema.sql`

**Location**: `../../../migration/provider_feature_schema.sql`

**Purpose**: Complete provider-agnostic schema with multi-provider support

- Creates all foundation tables (model_config, api_keys, service_registry, etc.)
- Sets up embedding tables for all supported dimensions (384, 768, 1024, 1536, 3072)
- Configures Row Level Security (RLS) policies
- Seeds essential model configurations
- Creates utility functions and views

**What it includes**:

- ✅ `model_config` table with all columns (embedding_dimensions, batch_size, etc.)
- ✅ API keys management
- ✅ Service registry for tracking providers
- ✅ Available models catalog
- ✅ Model usage tracking
- ✅ Embedding tables for different vector dimensions
- ✅ Vector similarity indexes
- ✅ RLS policies for security
- ✅ Provider-specific configurations
- ✅ Utility functions for dimension handling

**Note**: This is a comprehensive migration that replaces all previous migrations. It includes everything needed for multi-provider embedding support.

## 🚀 How to Run Migrations

### Method 1: Supabase Dashboard (Recommended)

1. Open your Supabase project dashboard
2. Navigate to **SQL Editor**
3. Copy and paste the contents of the migration file
4. Click **Run** to execute the migration
5. Verify the changes in the **Table Editor**
