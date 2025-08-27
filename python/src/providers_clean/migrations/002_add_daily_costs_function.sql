-- =====================================================
-- Add missing get_daily_costs function
-- =====================================================
-- This function aggregates daily usage costs for the specified number of days
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_daily_costs(start_date DATE)
RETURNS TABLE (
    date DATE,
    total_cost DECIMAL(10, 6),
    request_count BIGINT,
    total_tokens BIGINT
)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        DATE(mu.period_start) as date,
        SUM(mu.estimated_cost)::DECIMAL(10, 6) as total_cost,
        SUM(mu.request_count)::BIGINT as request_count,
        SUM(mu.total_tokens)::BIGINT as total_tokens
    FROM public.model_usage mu
    WHERE DATE(mu.period_start) >= start_date
    GROUP BY DATE(mu.period_start)
    ORDER BY date DESC;
END;
$$;

-- Grant execute permission to service role
GRANT EXECUTE ON FUNCTION public.get_daily_costs(DATE) TO service_role;

-- Add comment for documentation
COMMENT ON FUNCTION public.get_daily_costs IS 'Aggregates daily usage costs starting from the specified date - Service key access only';