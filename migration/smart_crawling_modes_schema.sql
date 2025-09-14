-- =====================================================
-- Smart Crawling Modes - Database Schema Enhancement
-- =====================================================
-- Extends the existing Archon database with specialized tables
-- for storing e-commerce and other domain-specific crawling data
-- =====================================================

-- =====================================================
-- SECTION 1: CRAWLING MODES CONFIGURATION
-- =====================================================

-- Add crawling mode settings to existing settings table
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
-- E-commerce Mode Settings
('CRAWL_MODE_ECOMMERCE_ENABLED', 'true', false, 'crawling_modes', 'Enable e-commerce specialized crawling mode'),
('CRAWL_MODE_ECOMMERCE_MAX_PAGES', '500', false, 'crawling_modes', 'Maximum pages to crawl per e-commerce site'),
('CRAWL_MODE_ECOMMERCE_EXTRACT_VARIANTS', 'true', false, 'crawling_modes', 'Extract product variants (size, color, etc.)'),
('CRAWL_MODE_ECOMMERCE_EXTRACT_REVIEWS', 'true', false, 'crawling_modes', 'Extract product reviews and ratings'),
('CRAWL_MODE_ECOMMERCE_TRACK_PRICES', 'true', false, 'crawling_modes', 'Enable price tracking and history'),

-- Blog Mode Settings
('CRAWL_MODE_BLOG_ENABLED', 'true', false, 'crawling_modes', 'Enable blog content crawling mode'),
('CRAWL_MODE_BLOG_EXTRACT_AUTHOR', 'true', false, 'crawling_modes', 'Extract author information from blog posts'),
('CRAWL_MODE_BLOG_EXTRACT_TAGS', 'true', false, 'crawling_modes', 'Extract tags and categories'),

-- Documentation Mode Settings
('CRAWL_MODE_DOCUMENTATION_ENABLED', 'true', false, 'crawling_modes', 'Enable documentation crawling mode'),
('CRAWL_MODE_DOCUMENTATION_EXTRACT_API', 'true', false, 'crawling_modes', 'Extract API endpoint information'),

-- Analytics Mode Settings
('CRAWL_MODE_ANALYTICS_ENABLED', 'true', false, 'crawling_modes', 'Enable analytics dashboard crawling'),
('CRAWL_MODE_ANALYTICS_WAIT_FOR_DYNAMIC', 'true', false, 'crawling_modes', 'Wait for dynamic content to load')

ON CONFLICT (key) DO NOTHING;

-- =====================================================
-- SECTION 2: E-COMMERCE PRODUCT DATA TABLES
-- =====================================================

-- Products table for e-commerce data
CREATE TABLE IF NOT EXISTS archon_ecommerce_products (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES archon_sources(source_id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    
    -- Basic product info
    name TEXT,
    description TEXT,
    short_description TEXT,
    sku TEXT,
    brand TEXT,
    categories JSONB DEFAULT '[]',
    
    -- Pricing information
    current_price DECIMAL(10,2),
    original_price DECIMAL(10,2),
    currency VARCHAR(3) DEFAULT 'USD',
    discount_percent DECIMAL(5,2),
    discount_amount DECIMAL(10,2),
    price_per_unit TEXT,
    
    -- Availability
    in_stock BOOLEAN,
    stock_count INTEGER,
    availability_status TEXT,
    
    -- Media
    images JSONB DEFAULT '[]',
    videos JSONB DEFAULT '[]',
    
    -- Reviews and ratings
    rating DECIMAL(3,2),
    review_count INTEGER,
    
    -- Product specifications
    specifications JSONB DEFAULT '{}',
    features JSONB DEFAULT '[]',
    
    -- Metadata
    data_quality VARCHAR(20) DEFAULT 'fair',
    confidence_score DECIMAL(3,2) DEFAULT 0.5,
    extraction_mode VARCHAR(50) DEFAULT 'ecommerce',
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_price_check TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Product variants table
CREATE TABLE IF NOT EXISTS archon_product_variants (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES archon_ecommerce_products(id) ON DELETE CASCADE,
    
    -- Variant info
    sku TEXT,
    name TEXT,
    attributes JSONB DEFAULT '{}', -- size, color, style, etc.
    
    -- Variant pricing
    price DECIMAL(10,2),
    original_price DECIMAL(10,2),
    
    -- Availability
    availability TEXT,
    inventory_count INTEGER,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Price history for tracking changes
CREATE TABLE IF NOT EXISTS archon_price_history (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES archon_ecommerce_products(id) ON DELETE CASCADE,
    
    -- Price data
    price DECIMAL(10,2) NOT NULL,
    original_price DECIMAL(10,2),
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- Change indicators
    price_change_percent DECIMAL(5,2),
    price_change_amount DECIMAL(10,2),
    
    -- Context
    availability_status TEXT,
    source_page TEXT,
    
    -- Timestamp
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Product reviews table
CREATE TABLE IF NOT EXISTS archon_product_reviews (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES archon_ecommerce_products(id) ON DELETE CASCADE,
    
    -- Review content
    title TEXT,
    content TEXT,
    rating DECIMAL(3,2),
    
    -- Reviewer info
    reviewer_name TEXT,
    reviewer_verified BOOLEAN DEFAULT FALSE,
    
    -- Review metadata
    helpful_votes INTEGER DEFAULT 0,
    total_votes INTEGER DEFAULT 0,
    
    -- Timestamps
    review_date TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- SECTION 3: WEBSITE CLASSIFICATION DATA
-- =====================================================

-- Website type detection results
CREATE TABLE IF NOT EXISTS archon_website_classifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES archon_sources(source_id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    
    -- Classification results
    detected_type VARCHAR(50) NOT NULL,
    confidence_score DECIMAL(3,2) NOT NULL,
    indicators_found JSONB DEFAULT '[]',
    
    -- Crawling mode recommendations
    recommended_mode VARCHAR(50),
    fallback_modes JSONB DEFAULT '[]',
    
    -- Detection metadata
    detection_method VARCHAR(50) DEFAULT 'automatic',
    manual_override BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    detected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_verified TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- SECTION 4: CRAWLING MODE PERFORMANCE METRICS
-- =====================================================

-- Crawling session performance data
CREATE TABLE IF NOT EXISTS archon_crawl_sessions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES archon_sources(source_id) ON DELETE CASCADE,
    
    -- Session info
    crawl_mode VARCHAR(50) NOT NULL,
    session_start TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    session_end TIMESTAMP WITH TIME ZONE,
    
    -- Performance metrics
    total_pages INTEGER DEFAULT 0,
    successful_extractions INTEGER DEFAULT 0,
    failed_extractions INTEGER DEFAULT 0,
    pages_per_second DECIMAL(6,3) DEFAULT 0.0,
    average_response_time DECIMAL(8,3) DEFAULT 0.0,
    
    -- Quality metrics
    average_confidence DECIMAL(3,2) DEFAULT 0.0,
    data_quality_distribution JSONB DEFAULT '{}',
    
    -- Error tracking
    errors JSONB DEFAULT '[]',
    warnings JSONB DEFAULT '[]',
    
    -- Configuration used
    config_snapshot JSONB DEFAULT '{}'
);

-- =====================================================
-- SECTION 5: INDEXES FOR PERFORMANCE
-- =====================================================

-- E-commerce products indexes
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_source_id ON archon_ecommerce_products(source_id);
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_url ON archon_ecommerce_products(url);
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_sku ON archon_ecommerce_products(sku) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_brand ON archon_ecommerce_products(brand) WHERE brand IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_price ON archon_ecommerce_products(current_price) WHERE current_price IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_rating ON archon_ecommerce_products(rating) WHERE rating IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ecommerce_products_created_at ON archon_ecommerce_products(created_at);

-- Product variants indexes
CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON archon_product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_sku ON archon_product_variants(sku) WHERE sku IS NOT NULL;

-- Price history indexes
CREATE INDEX IF NOT EXISTS idx_price_history_product_id ON archon_price_history(product_id);
CREATE INDEX IF NOT EXISTS idx_price_history_recorded_at ON archon_price_history(recorded_at);

-- Product reviews indexes
CREATE INDEX IF NOT EXISTS idx_product_reviews_product_id ON archon_product_reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_product_reviews_rating ON archon_product_reviews(rating) WHERE rating IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_reviews_review_date ON archon_product_reviews(review_date);

-- Website classifications indexes
CREATE INDEX IF NOT EXISTS idx_website_classifications_source_id ON archon_website_classifications(source_id);
CREATE INDEX IF NOT EXISTS idx_website_classifications_detected_type ON archon_website_classifications(detected_type);
CREATE INDEX IF NOT EXISTS idx_website_classifications_confidence ON archon_website_classifications(confidence_score);

-- Crawl sessions indexes
CREATE INDEX IF NOT EXISTS idx_crawl_sessions_source_id ON archon_crawl_sessions(source_id);
CREATE INDEX IF NOT EXISTS idx_crawl_sessions_mode ON archon_crawl_sessions(crawl_mode);
CREATE INDEX IF NOT EXISTS idx_crawl_sessions_start ON archon_crawl_sessions(session_start);

-- =====================================================
-- SECTION 6: VIEWS FOR COMMON QUERIES
-- =====================================================

-- View for product price intelligence
CREATE OR REPLACE VIEW archon_product_price_intelligence AS
SELECT 
    p.id,
    p.name,
    p.brand,
    p.current_price,
    p.original_price,
    p.discount_percent,
    p.currency,
    p.url,
    p.last_price_check,
    ph.price_change_percent,
    ph.recorded_at as last_price_change,
    s.source_id,
    s.title as source_name
FROM archon_ecommerce_products p
LEFT JOIN archon_sources s ON p.source_id = s.source_id
LEFT JOIN LATERAL (
    SELECT price_change_percent, recorded_at
    FROM archon_price_history 
    WHERE product_id = p.id 
    ORDER BY recorded_at DESC 
    LIMIT 1
) ph ON TRUE
WHERE p.current_price IS NOT NULL;

-- View for crawling performance summary
CREATE OR REPLACE VIEW archon_crawling_performance AS
SELECT 
    cs.crawl_mode,
    COUNT(*) as total_sessions,
    AVG(cs.successful_extractions) as avg_successful_extractions,
    AVG(cs.pages_per_second) as avg_pages_per_second,
    AVG(cs.average_response_time) as avg_response_time,
    AVG(cs.average_confidence) as avg_confidence_score,
    MAX(cs.session_start) as last_crawl
FROM archon_crawl_sessions cs
WHERE cs.session_end IS NOT NULL
GROUP BY cs.crawl_mode;

-- =====================================================
-- SECTION 7: TRIGGERS FOR DATA MAINTENANCE
-- =====================================================

-- Update timestamp trigger for products
CREATE OR REPLACE FUNCTION update_product_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_ecommerce_products_updated_at
    BEFORE UPDATE ON archon_ecommerce_products
    FOR EACH ROW
    EXECUTE FUNCTION update_product_updated_at();

CREATE TRIGGER update_product_variants_updated_at
    BEFORE UPDATE ON archon_product_variants
    FOR EACH ROW
    EXECUTE FUNCTION update_product_updated_at();

-- Automatic price history trigger
CREATE OR REPLACE FUNCTION track_price_changes()
RETURNS TRIGGER AS $$
BEGIN
    -- Insert price history record when price changes
    IF OLD.current_price IS DISTINCT FROM NEW.current_price THEN
        INSERT INTO archon_price_history (
            product_id,
            price,
            original_price,
            currency,
            price_change_percent,
            price_change_amount,
            availability_status,
            source_page
        ) VALUES (
            NEW.id,
            NEW.current_price,
            NEW.original_price,
            NEW.currency,
            CASE 
                WHEN OLD.current_price IS NOT NULL AND OLD.current_price > 0 
                THEN ((NEW.current_price - OLD.current_price) / OLD.current_price) * 100
                ELSE NULL
            END,
            CASE 
                WHEN OLD.current_price IS NOT NULL 
                THEN NEW.current_price - OLD.current_price
                ELSE NULL
            END,
            NEW.availability_status,
            NEW.url
        );
        
        -- Update last price check timestamp
        NEW.last_price_check = NOW();
    END IF;
    
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER track_product_price_changes
    BEFORE UPDATE ON archon_ecommerce_products
    FOR EACH ROW
    EXECUTE FUNCTION track_price_changes();

-- =====================================================
-- SECTION 8: RLS POLICIES
-- =====================================================

-- Enable RLS on new tables
ALTER TABLE archon_ecommerce_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_product_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_website_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_crawl_sessions ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for service role access
CREATE POLICY "Allow service role full access" ON archon_ecommerce_products
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access" ON archon_product_variants
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access" ON archon_price_history
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access" ON archon_product_reviews
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access" ON archon_website_classifications
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access" ON archon_crawl_sessions
    FOR ALL USING (auth.role() = 'service_role');

-- Create RLS policies for authenticated users
CREATE POLICY "Allow authenticated users read access" ON archon_ecommerce_products
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users read access" ON archon_product_variants
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users read access" ON archon_price_history
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users read access" ON archon_product_reviews
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users read access" ON archon_website_classifications
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users read access" ON archon_crawl_sessions
    FOR SELECT TO authenticated USING (true);

-- =====================================================
-- COMPLETION MESSAGE
-- =====================================================

-- Add completion comment
COMMENT ON TABLE archon_ecommerce_products IS 'E-commerce product data with comprehensive pricing and variant information';
COMMENT ON TABLE archon_product_variants IS 'Product variants (size, color, style) with individual pricing';
COMMENT ON TABLE archon_price_history IS 'Historical price tracking for competitive intelligence';
COMMENT ON TABLE archon_product_reviews IS 'Customer reviews and ratings for products';
COMMENT ON TABLE archon_website_classifications IS 'Automatic website type detection results';
COMMENT ON TABLE archon_crawl_sessions IS 'Crawling session performance and quality metrics';

SELECT 'Smart Crawling Modes database schema has been successfully created!' as status;