-- Mexico Document Processor Database Schema
-- Tracks document requests, requirements, and progress for Mexican government documents

-- Main table for document requests
CREATE TABLE IF NOT EXISTS mexico_document_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    request_id TEXT UNIQUE NOT NULL,

    -- Applicant information
    applicant_name TEXT NOT NULL,
    curp TEXT, -- Clave Única de Registro de Población
    nss TEXT, -- Número de Seguridad Social (for AFORE recovery)
    state TEXT, -- Mexican state
    applicant_info JSONB DEFAULT '{}', -- Additional applicant details

    -- Request details
    document_codes TEXT[] NOT NULL, -- Array of document type codes
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),

    -- Progress tracking
    steps_completed TEXT[] DEFAULT ARRAY[]::TEXT[],
    next_steps TEXT[] DEFAULT ARRAY[]::TEXT[],
    forms_filled TEXT[] DEFAULT ARRAY[]::TEXT[],
    documents_obtained TEXT[] DEFAULT ARRAY[]::TEXT[],

    -- Scraped information
    scraped_info JSONB DEFAULT '{}',

    -- Cost and timeline estimates
    estimated_completion_weeks INTEGER,
    estimated_total_cost_mxn DECIMAL(10, 2),
    actual_total_cost_mxn DECIMAL(10, 2),

    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Table for scraped government website data
CREATE TABLE IF NOT EXISTS mexico_scraped_data (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_code TEXT NOT NULL,
    state TEXT, -- NULL for federal documents

    -- Scraped content
    website_url TEXT NOT NULL,
    requirements TEXT[] DEFAULT ARRAY[]::TEXT[],
    procedures TEXT[] DEFAULT ARRAY[]::TEXT[],
    fees JSONB DEFAULT '{}', -- { "normal": "$1000 MXN", "express": "$2500 MXN" }
    processing_times JSONB DEFAULT '{}', -- { "normal": "15-20 days", "express": "5-7 days" }
    office_locations JSONB DEFAULT '[]', -- Array of { city, address, hours }
    online_portal_url TEXT,
    additional_notes TEXT[] DEFAULT ARRAY[]::TEXT[],

    -- Scraping metadata
    last_scraped TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    scrape_success BOOLEAN DEFAULT true,
    scrape_error TEXT,

    -- Uniqueness: one entry per document+state combination
    UNIQUE(document_code, state)
);

-- Table for tracking individual document progress within a request
CREATE TABLE IF NOT EXISTS mexico_document_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID REFERENCES mexico_document_requests(id) ON DELETE CASCADE,
    document_code TEXT NOT NULL,

    -- Document-specific progress
    status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'gathering_docs', 'submitted', 'processing', 'ready', 'obtained')),

    -- Requirements checklist
    required_documents JSONB DEFAULT '[]', -- Array of { name, obtained: boolean }

    -- Application tracking
    application_number TEXT, -- Folio/número de trámite
    appointment_date TIMESTAMP WITH TIME ZONE,
    submission_date TIMESTAMP WITH TIME ZONE,
    expected_completion_date TIMESTAMP WITH TIME ZONE,
    obtained_date TIMESTAMP WITH TIME ZONE,

    -- Costs
    fees_paid_mxn DECIMAL(10, 2),
    payment_receipt TEXT, -- Receipt number or file reference

    -- Notes
    notes TEXT,

    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table for form templates and auto-fill data
CREATE TABLE IF NOT EXISTS mexico_form_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_code TEXT NOT NULL,
    form_name TEXT NOT NULL,

    -- Form structure
    form_fields JSONB NOT NULL, -- Array of { field_name, field_type, required, mapping }
    -- mapping indicates which user info field to use (e.g., "applicant_name" -> name field)

    -- Form metadata
    form_url TEXT,
    pdf_fillable BOOLEAN DEFAULT false,
    online_only BOOLEAN DEFAULT false,

    -- Version tracking
    version TEXT DEFAULT '1.0',
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(document_code, form_name)
);

-- Table for user-saved applicant profiles (for quick re-use)
CREATE TABLE IF NOT EXISTS mexico_applicant_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    profile_name TEXT NOT NULL, -- e.g., "Self", "Spouse", "Child"

    -- Personal information
    full_name TEXT NOT NULL,
    curp TEXT,
    nss TEXT,
    rfc TEXT,
    date_of_birth DATE,
    place_of_birth TEXT,
    nationality TEXT DEFAULT 'Mexicana',

    -- Contact information
    email TEXT,
    phone TEXT,
    address JSONB, -- { street, number, colony, city, state, postal_code }

    -- Identification
    ine_number TEXT,
    passport_number TEXT,

    -- Family information (for certain documents)
    marital_status TEXT,
    spouse_name TEXT,
    parents_names JSONB, -- { mother, father }

    -- Employment (for visa/migration documents)
    employment_info JSONB,

    -- Additional data
    additional_info JSONB DEFAULT '{}',

    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(user_id, profile_name)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_mexico_requests_user_id ON mexico_document_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_mexico_requests_status ON mexico_document_requests(status);
CREATE INDEX IF NOT EXISTS idx_mexico_requests_created ON mexico_document_requests(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mexico_scraped_document ON mexico_scraped_data(document_code);
CREATE INDEX IF NOT EXISTS idx_mexico_scraped_updated ON mexico_scraped_data(last_scraped DESC);

CREATE INDEX IF NOT EXISTS idx_mexico_progress_request ON mexico_document_progress(request_id);
CREATE INDEX IF NOT EXISTS idx_mexico_progress_status ON mexico_document_progress(status);

CREATE INDEX IF NOT EXISTS idx_mexico_profiles_user ON mexico_applicant_profiles(user_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_mexico_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for auto-updating timestamps
CREATE TRIGGER update_mexico_requests_updated_at
    BEFORE UPDATE ON mexico_document_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_mexico_updated_at();

CREATE TRIGGER update_mexico_progress_updated_at
    BEFORE UPDATE ON mexico_document_progress
    FOR EACH ROW
    EXECUTE FUNCTION update_mexico_updated_at();

CREATE TRIGGER update_mexico_profiles_updated_at
    BEFORE UPDATE ON mexico_applicant_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_mexico_updated_at();

-- Row Level Security (RLS) policies
-- Enable RLS on all tables
ALTER TABLE mexico_document_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE mexico_document_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE mexico_applicant_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE mexico_scraped_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE mexico_form_templates ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own document requests
CREATE POLICY mexico_requests_user_policy ON mexico_document_requests
    FOR ALL
    USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Policy: Users can see progress for their own requests
CREATE POLICY mexico_progress_user_policy ON mexico_document_progress
    FOR ALL
    USING (
        request_id IN (
            SELECT id FROM mexico_document_requests
            WHERE user_id = current_setting('request.jwt.claims', true)::json->>'sub'
        )
    );

-- Policy: Users can only see their own profiles
CREATE POLICY mexico_profiles_user_policy ON mexico_applicant_profiles
    FOR ALL
    USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Policy: Scraped data is public (read-only for users)
CREATE POLICY mexico_scraped_data_read_policy ON mexico_scraped_data
    FOR SELECT
    USING (true);

-- Policy: Form templates are public (read-only)
CREATE POLICY mexico_forms_read_policy ON mexico_form_templates
    FOR SELECT
    USING (true);

-- Insert some initial form templates
INSERT INTO mexico_form_templates (document_code, form_name, form_fields, form_url) VALUES
(
    'licencia',
    'Solicitud de Licencia de Conducir',
    '[
        {"field_name": "nombre_completo", "field_type": "text", "required": true, "mapping": "full_name"},
        {"field_name": "curp", "field_type": "text", "required": true, "mapping": "curp"},
        {"field_name": "fecha_nacimiento", "field_type": "date", "required": true, "mapping": "date_of_birth"},
        {"field_name": "domicilio", "field_type": "address", "required": true, "mapping": "address"},
        {"field_name": "tipo_licencia", "field_type": "select", "required": true, "options": ["A", "B", "C", "D", "E"]}
    ]'::jsonb,
    'https://www.gob.mx/tramites/licencia'
),
(
    'pasaporte',
    'Solicitud de Pasaporte Ordinario',
    '[
        {"field_name": "nombre_completo", "field_type": "text", "required": true, "mapping": "full_name"},
        {"field_name": "curp", "field_type": "text", "required": true, "mapping": "curp"},
        {"field_name": "lugar_nacimiento", "field_type": "text", "required": true, "mapping": "place_of_birth"},
        {"field_name": "nacionalidad", "field_type": "text", "required": true, "mapping": "nationality"},
        {"field_name": "correo_electronico", "field_type": "email", "required": true, "mapping": "email"},
        {"field_name": "telefono", "field_type": "tel", "required": true, "mapping": "phone"}
    ]'::jsonb,
    'https://citas.sre.gob.mx/'
),
(
    'afore',
    'Solicitud de Retiro de AFORE',
    '[
        {"field_name": "nombre_completo", "field_type": "text", "required": true, "mapping": "full_name"},
        {"field_name": "curp", "field_type": "text", "required": true, "mapping": "curp"},
        {"field_name": "nss", "field_type": "text", "required": true, "mapping": "nss"},
        {"field_name": "rfc", "field_type": "text", "required": true, "mapping": "rfc"},
        {"field_name": "fecha_nacimiento", "field_type": "date", "required": true, "mapping": "date_of_birth"},
        {"field_name": "domicilio", "field_type": "address", "required": true, "mapping": "address"},
        {"field_name": "cuenta_bancaria", "field_type": "text", "required": true, "mapping": "bank_account"}
    ]'::jsonb,
    'https://www.e-sar.com.mx/PortalEsar/'
)
ON CONFLICT (document_code, form_name) DO NOTHING;

-- Comments for documentation
COMMENT ON TABLE mexico_document_requests IS 'Tracks user requests for Mexican government documents';
COMMENT ON TABLE mexico_scraped_data IS 'Cached data scraped from Mexican government websites';
COMMENT ON TABLE mexico_document_progress IS 'Progress tracking for individual documents within a request';
COMMENT ON TABLE mexico_form_templates IS 'Form templates for auto-filling Mexican government forms';
COMMENT ON TABLE mexico_applicant_profiles IS 'User-saved profiles for quick form filling';

COMMENT ON COLUMN mexico_document_requests.curp IS 'Clave Única de Registro de Población - Mexican national ID number';
COMMENT ON COLUMN mexico_document_requests.nss IS 'Número de Seguridad Social - needed for AFORE recovery';
COMMENT ON COLUMN mexico_document_requests.document_codes IS 'Array of document type codes (licencia, pasaporte, etc.)';
