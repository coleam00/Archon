-- =====================================================
-- Specialized Crawling Data Schema Enhancement
-- =====================================================
-- This migration adds tables and columns to support
-- specialized crawling modes with structured data storage
-- =====================================================

-- =====================================================
-- E-COMMERCE PRODUCTS TABLE
-- =====================================================

-- Create table for e-commerce product data
CREATE TABLE IF NOT EXISTS archon_ecommerce_products (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    url TEXT NOT NULL,
    source_id TEXT, -- Reference to archon_sources
    
    -- Basic Product Information
    product_name TEXT,
    brand TEXT,
    sku TEXT,
    category TEXT,
    description TEXT,
    
    -- Pricing Information
    price_current DECIMAL(10,2),
    price_original DECIMAL(10,2),
    currency VARCHAR(3) DEFAULT 'USD',
    discount_percentage DECIMAL(5,2),
    
    -- Availability & Inventory
    availability VARCHAR(50), -- in_stock, out_of_stock, limited, pre_order
    inventory_count INTEGER,
    
    -- Ratings & Reviews
    rating DECIMAL(3,2), -- 0.00 to 5.00
    rating_count INTEGER DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    
    -- Product Media
    images JSONB DEFAULT '[]', -- Array of image URLs
    videos JSONB DEFAULT '[]', -- Array of video URLs
    
    -- Product Variants (size, color, style, etc.)
    variants JSONB DEFAULT '[]', -- Array of variant objects
    
    -- Technical Specifications
    specifications JSONB DEFAULT '{}', -- Key-value pairs
    features JSONB DEFAULT '[]', -- Array of feature strings
    
    -- Competitive Intelligence
    competitor_data JSONB DEFAULT '{}', -- Competitor pricing, etc.
    
    -- Extraction Metadata
    platform_detected VARCHAR(50), -- amazon, shopify, woocommerce, etc.
    extraction_confidence DECIMAL(3,2), -- 0.00 to 1.00
    structured_data_found JSONB DEFAULT '{}', -- Schema.org, JSON-LD data
    
    -- Timestamps
    first_crawled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for e-commerce products
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_url ON archon_ecommerce_products(url);
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_source_id ON archon_ecommerce_products(source_id);
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_brand ON archon_ecommerce_products(brand);
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_category ON archon_ecommerce_products(category);
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_platform ON archon_ecommerce_products(platform_detected);
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_availability ON archon_ecommerce_products(availability);
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_price ON archon_ecommerce_products(price_current);
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_updated ON archon_ecommerce_products(last_updated_at);

-- Create GIN indexes for JSONB columns
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_variants ON archon_ecommerce_products USING GIN(variants);
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_specs ON archon_ecommerce_products USING GIN(specifications);
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_features ON archon_ecommerce_products USING GIN(features);

-- =====================================================
-- CRAWLING MODES CONFIGURATION TABLE
-- =====================================================

-- Table to store crawling mode configurations
CREATE TABLE IF NOT EXISTS archon_crawling_modes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    mode_name VARCHAR(50) UNIQUE NOT NULL, -- ecommerce, blog, documentation, etc.
    enabled BOOLEAN DEFAULT TRUE,
    
    -- Configuration Settings
    page_timeout INTEGER DEFAULT 30000,
    delay_before_html DECIMAL(4,2) DEFAULT 0.5,
    wait_strategy VARCHAR(20) DEFAULT 'domcontentloaded',
    stealth_mode BOOLEAN DEFAULT FALSE,
    anti_bot_mode BOOLEAN DEFAULT FALSE,
    
    -- Extraction Settings
    extract_structured_data BOOLEAN DEFAULT TRUE,
    extract_images BOOLEAN DEFAULT TRUE,
    extract_links BOOLEAN DEFAULT TRUE,
    
    -- Mode-specific Configuration
    mode_config JSONB DEFAULT '{}',
    
    -- URL Patterns for Auto-detection
    url_patterns JSONB DEFAULT '[]', -- Array of regex patterns
    
    -- Performance Settings
    max_retries INTEGER DEFAULT 3,
    concurrent_limit INTEGER DEFAULT 5,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for crawling modes
CREATE INDEX IF NOT EXISTS idx_crawling_modes_name ON archon_crawling_modes(mode_name);
CREATE INDEX IF NOT EXISTS idx_crawling_modes_enabled ON archon_crawling_modes(enabled);

-- =====================================================
-- CRAWLING MODE PERFORMANCE TRACKING
-- =====================================================

-- Table to track performance metrics for each crawling mode
CREATE TABLE IF NOT EXISTS archon_crawling_performance (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    mode_name VARCHAR(50) NOT NULL,
    
    -- Performance Metrics
    total_crawls INTEGER DEFAULT 0,
    successful_crawls INTEGER DEFAULT 0,
    failed_crawls INTEGER DEFAULT 0,
    average_response_time DECIMAL(8,3) DEFAULT 0.0, -- in seconds
    
    -- Time Period Tracking
    date_tracked DATE DEFAULT CURRENT_DATE,
    
    -- Additional Metrics
    data_extraction_success_rate DECIMAL(5,2) DEFAULT 0.0,
    structured_data_found_rate DECIMAL(5,2) DEFAULT 0.0,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(mode_name, date_tracked)
);

-- Create indexes for performance tracking
CREATE INDEX IF NOT EXISTS idx_crawling_performance_mode ON archon_crawling_performance(mode_name);
CREATE INDEX IF NOT EXISTS idx_crawling_performance_date ON archon_crawling_performance(date_tracked);

-- =====================================================
-- STRUCTURED DATA EXTRACTION TABLE
-- =====================================================

-- Generic table for storing structured data from any crawling mode
CREATE TABLE IF NOT EXISTS archon_structured_data (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    url TEXT NOT NULL,
    source_id TEXT, -- Reference to archon_sources
    
    -- Data Classification
    data_type VARCHAR(50) NOT NULL, -- product, article, person, organization, etc.
    extraction_mode VARCHAR(50) NOT NULL, -- ecommerce, blog, documentation, etc.
    
    -- Structured Data
    structured_data JSONB NOT NULL DEFAULT '{}',
    schema_type VARCHAR(100), -- Schema.org type (Product, Article, etc.)
    
    -- Extraction Metadata
    confidence_score DECIMAL(3,2) DEFAULT 0.0,
    extraction_method VARCHAR(50), -- json_ld, microdata, heuristics, etc.
    
    -- Quality Metrics
    completeness_score DECIMAL(3,2) DEFAULT 0.0, -- How complete is the data
    validation_status VARCHAR(20) DEFAULT 'pending', -- valid, invalid, pending
    
    -- Timestamps
    extracted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for structured data
CREATE INDEX IF NOT EXISTS idx_structured_data_url ON archon_structured_data(url);
CREATE INDEX IF NOT EXISTS idx_structured_data_source_id ON archon_structured_data(source_id);
CREATE INDEX IF NOT EXISTS idx_structured_data_type ON archon_structured_data(data_type);
CREATE INDEX IF NOT EXISTS idx_structured_data_mode ON archon_structured_data(extraction_mode);
CREATE INDEX IF NOT EXISTS idx_structured_data_schema ON archon_structured_data(schema_type);
CREATE INDEX IF NOT EXISTS idx_structured_data_extracted ON archon_structured_data(extracted_at);

-- Create GIN index for structured data content
CREATE INDEX IF NOT EXISTS idx_structured_data_content ON archon_structured_data USING GIN(structured_data);

-- =====================================================
-- ENHANCE EXISTING SOURCES TABLE
-- =====================================================

-- Add columns to existing archon_sources table for crawling mode support
-- (Only if the table exists)
DO $$
BEGIN
    -- Check if archon_sources table exists
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'archon_sources') THEN
        -- Add new columns
        ALTER TABLE archon_sources 
        ADD COLUMN IF NOT EXISTS crawling_mode VARCHAR(50) DEFAULT 'standard',
        ADD COLUMN IF NOT EXISTS extraction_stats JSONB DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS structured_data_count INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_mode_used VARCHAR(50),
        ADD COLUMN IF NOT EXISTS mode_detection_confidence DECIMAL(3,2) DEFAULT 0.0;

        -- Create indexes for new columns
        CREATE INDEX IF NOT EXISTS idx_sources_crawling_mode ON archon_sources(crawling_mode);
        CREATE INDEX IF NOT EXISTS idx_sources_last_mode ON archon_sources(last_mode_used);
        
        RAISE NOTICE 'Enhanced archon_sources table with crawling mode support';
    ELSE
        RAISE NOTICE 'archon_sources table does not exist, skipping enhancement';
    END IF;
END
$$;

-- =====================================================
-- MIGRATION SUCCESS
-- =====================================================

-- Final success message
DO $$
BEGIN
    RAISE NOTICE '=========================================';
    RAISE NOTICE 'SPECIALIZED CRAWLING MIGRATION COMPLETE';
    RAISE NOTICE '=========================================';
    RAISE NOTICE 'Tables created: 4';
    RAISE NOTICE '- archon_ecommerce_products';
    RAISE NOTICE '- archon_crawling_modes';
    RAISE NOTICE '- archon_crawling_performance';
    RAISE NOTICE '- archon_structured_data';
    RAISE NOTICE 'Default crawling modes initialized: 4';
    RAISE NOTICE 'Migration completed successfully!';
END
$$;

-- =====================================================
-- INITIALIZE DEFAULT CRAWLING MODES
-- =====================================================

-- Insert default crawling mode configurations
INSERT INTO archon_crawling_modes (mode_name, enabled, mode_config, url_patterns) VALUES
-- Standard Mode
('standard', true, 
 '{"description": "General purpose crawling for any website"}',
 '[".*"]'),

-- E-commerce Mode
('ecommerce', true, 
 '{
   "description": "Specialized crawling for e-commerce sites with product data extraction",
   "extract_pricing": true,
   "extract_reviews": true,
   "extract_variants": true,
   "extract_inventory": true,
   "stealth_mode": true,
   "page_timeout": 45000
 }',
 '[
   "regex:amazon\\.",
   "regex:ebay\\.",
   "regex:shopify\\.",
   "regex:etsy\\.",
   "regex:walmart\\.",
   "regex:/product/",
   "regex:/item/",
   "regex:/p/",
   "regex:/shop/"
 ]'),

-- Blog Mode (placeholder for future implementation)
('blog', false,
 '{
   "description": "Optimized for blog posts and article content",
   "extract_author": true,
   "extract_publish_date": true,
   "extract_tags": true,
   "content_focus": "article"
 }',
 '[
   "regex:blog\\.",
   "regex:wordpress\\.",
   "regex:medium\\.",
   "regex:/blog/",
   "regex:/post/",
   "regex:/article/"
 ]'),

-- Documentation Mode (placeholder for future implementation)
('documentation', false,
 '{
   "description": "Enhanced crawling for documentation sites",
   "extract_code_examples": true,
   "extract_navigation": true,
   "extract_api_references": true,
   "wait_for_code_highlighting": true
 }',
 '[
   "regex:docs\\.",
   "regex:documentation\\.",
   "regex:readthedocs\\.",
   "regex:/docs/",
   "regex:/api/",
   "regex:/guide/"
 ]')

ON CONFLICT (mode_name) DO UPDATE SET
    mode_config = EXCLUDED.mode_config,
    url_patterns = EXCLUDED.url_patterns,
    updated_at = NOW();

-- =====================================================
-- FUNCTIONS AND TRIGGERS
-- =====================================================

-- Function to update last_updated_at timestamp
CREATE OR REPLACE FUNCTION update_last_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for automatic timestamp updates
CREATE TRIGGER update_ecommerce_products_timestamp
    BEFORE UPDATE ON archon_ecommerce_products
    FOR EACH ROW
    EXECUTE FUNCTION update_last_updated_at();

CREATE TRIGGER update_crawling_modes_timestamp
    BEFORE UPDATE ON archon_crawling_modes
    FOR EACH ROW
    EXECUTE FUNCTION update_last_updated_at();

CREATE TRIGGER update_crawling_performance_timestamp
    BEFORE UPDATE ON archon_crawling_performance
    FOR EACH ROW
    EXECUTE FUNCTION update_last_updated_at();

-- =====================================================
-- RLS (ROW LEVEL SECURITY) POLICIES
-- =====================================================

-- Enable RLS for new tables
ALTER TABLE archon_ecommerce_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_crawling_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_crawling_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_structured_data ENABLE ROW LEVEL SECURITY;

-- Create policies for service role access
CREATE POLICY "Allow service role full access" ON archon_ecommerce_products
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access" ON archon_crawling_modes
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access" ON archon_crawling_performance
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access" ON archon_structured_data
    FOR ALL USING (auth.role() = 'service_role');

-- Create policies for authenticated users (read-only by default)
CREATE POLICY "Allow authenticated users to read" ON archon_ecommerce_products
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users to read" ON archon_crawling_modes
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users to read" ON archon_crawling_performance
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users to read" ON archon_structured_data
    FOR SELECT TO authenticated USING (true);

-- =====================================================
-- COMMENTS FOR DOCUMENTATION
-- =====================================================

COMMENT ON TABLE archon_ecommerce_products IS 'Stores extracted e-commerce product data with pricing, variants, and competitive intelligence';
COMMENT ON TABLE archon_crawling_modes IS 'Configuration settings for different specialized crawling modes';
COMMENT ON TABLE archon_crawling_performance IS 'Performance metrics and statistics for crawling modes';
COMMENT ON TABLE archon_structured_data IS 'Generic storage for structured data extracted by any crawling mode';

COMMENT ON COLUMN archon_ecommerce_products.variants IS 'JSON array of product variants (size, color, style options)';
COMMENT ON COLUMN archon_ecommerce_products.specifications IS 'JSON object of technical specifications and features';
COMMENT ON COLUMN archon_ecommerce_products.competitor_data IS 'Competitive intelligence data including pricing comparisons';
COMMENT ON COLUMN archon_crawling_modes.mode_config IS 'Mode-specific configuration parameters as JSON';
COMMENT ON COLUMN archon_crawling_modes.url_patterns IS 'Array of regex patterns for automatic mode detection';
COMMENT ON COLUMN archon_structured_data.structured_data IS 'Extracted structured data in JSON format';

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================

-- Log migration completion (only if archon_settings table exists)
DO $$
BEGIN
    -- Check if archon_settings table exists before trying to insert
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'archon_settings') THEN
        INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
        ('SPECIALIZED_CRAWLING_SCHEMA_VERSION', '1.0.0', false, 'migration', 'Version of specialized crawling schema')
        ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = NOW();
        
        RAISE NOTICE 'Migration logged to archon_settings table';
    ELSE
        RAISE NOTICE 'archon_settings table does not exist, skipping migration log';
    END IF;
END
$$;