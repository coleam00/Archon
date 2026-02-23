CREATE TABLE IF NOT EXISTS validation_council_decisions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    work_order_id TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    user_request_summary TEXT,
    decision TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    decided_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    notes TEXT,
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_council_work_order_id ON validation_council_decisions(work_order_id);
CREATE INDEX IF NOT EXISTS idx_council_decision ON validation_council_decisions(decision);
CREATE INDEX IF NOT EXISTS idx_council_created_at ON validation_council_decisions(created_at DESC);

ALTER TABLE validation_council_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for service role" ON validation_council_decisions;
CREATE POLICY "Allow all for service role" ON validation_council_decisions
    FOR ALL USING (true) WITH CHECK (true);
