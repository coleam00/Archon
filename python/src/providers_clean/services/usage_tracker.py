"""
Usage Tracker for Model Usage and Cost Monitoring

Tracks usage metrics and calculates costs for different AI models.
"""

import asyncio
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional, Dict, List, Any
from supabase import Client
from pydantic import BaseModel, Field
import logging

logger = logging.getLogger(__name__)


class UsageMetrics(BaseModel):
    """Usage metrics for a service and model"""
    service_name: str
    model_string: str
    request_count: int = 0
    total_tokens: int = 0
    estimated_cost: Decimal = Decimal('0')
    period_start: datetime
    period_end: datetime


class UsageSummary(BaseModel):
    """Summary of usage across services"""
    total_requests: int = 0
    total_tokens: int = 0
    total_cost: Decimal = Decimal('0')
    by_service: Dict[str, Dict[str, Any]] = {}
    by_model: Dict[str, Dict[str, Any]] = {}


class UsageTracker:
    """Track model usage and costs"""
    
    # Cost mapping per 1K tokens (prices as of 2024)
    # Format: {model_string: {'input': cost_per_1k, 'output': cost_per_1k}}
    COST_TABLE = {
        # OpenAI Models
        'openai:gpt-4o': {'input': 0.0025, 'output': 0.01},
        'openai:gpt-4o-mini': {'input': 0.00015, 'output': 0.0006},
        'openai:gpt-4-turbo': {'input': 0.01, 'output': 0.03},
        'openai:gpt-4': {'input': 0.03, 'output': 0.06},
        'openai:gpt-3.5-turbo': {'input': 0.0005, 'output': 0.0015},
        'openai:text-embedding-3-small': {'input': 0.00002, 'output': 0},
        'openai:text-embedding-3-large': {'input': 0.00013, 'output': 0},
        'openai:text-embedding-ada-002': {'input': 0.0001, 'output': 0},
        
        # Anthropic Models
        'anthropic:claude-3-opus-20240229': {'input': 0.015, 'output': 0.075},
        'anthropic:claude-3-sonnet-20240229': {'input': 0.003, 'output': 0.015},
        'anthropic:claude-3-haiku-20240307': {'input': 0.00025, 'output': 0.00125},
        'anthropic:claude-2.1': {'input': 0.008, 'output': 0.024},
        'anthropic:claude-2': {'input': 0.008, 'output': 0.024},
        
        # Google/Gemini Models
        'gemini:gemini-1.5-pro': {'input': 0.00125, 'output': 0.005},
        'gemini:gemini-1.5-flash': {'input': 0.000075, 'output': 0.0003},
        'gemini:gemini-pro': {'input': 0.0005, 'output': 0.0015},
        'google:gemini-1.5-pro': {'input': 0.00125, 'output': 0.005},
        'google:gemini-1.5-flash': {'input': 0.000075, 'output': 0.0003},
        
        # Groq Models (very competitive pricing)
        'groq:llama-3.1-70b-versatile': {'input': 0.00059, 'output': 0.00079},
        'groq:llama-3.1-8b-instant': {'input': 0.00005, 'output': 0.00008},
        'groq:mixtral-8x7b-32768': {'input': 0.00024, 'output': 0.00024},
        
        # Mistral Models
        'mistral:mistral-large-latest': {'input': 0.002, 'output': 0.006},
        'mistral:mistral-medium-latest': {'input': 0.00065, 'output': 0.00196},
        'mistral:mistral-small-latest': {'input': 0.0002, 'output': 0.0006},
        
        # Cohere Models
        'cohere:command-r-plus': {'input': 0.003, 'output': 0.015},
        'cohere:command-r': {'input': 0.0005, 'output': 0.0015},
        'cohere:embed-english-v3.0': {'input': 0.0001, 'output': 0},
        
        # Ollama (local, no cost)
        'ollama:llama3': {'input': 0, 'output': 0},
        'ollama:mistral': {'input': 0, 'output': 0},
        'ollama:codellama': {'input': 0, 'output': 0},
    }
    
    def __init__(self, supabase_client: Client):
        """Initialize with Supabase client"""
        self.db = supabase_client
    
    async def track_usage(
        self,
        service_name: str,
        model_string: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        request_count: int = 1
    ) -> None:
        """
        Track usage for a model.
        
        Args:
            service_name: Name of the service using the model
            model_string: PydanticAI model string
            input_tokens: Number of input tokens
            output_tokens: Number of output tokens
            request_count: Number of requests (default 1)
        """
        try:
            # Calculate cost
            cost = self._calculate_cost(model_string, input_tokens, output_tokens)
            total_tokens = input_tokens + output_tokens
            
            # Get current period (daily)
            now = datetime.utcnow()
            period_start = datetime.combine(now.date(), datetime.min.time())
            
            # Call the database function to increment usage
            await asyncio.to_thread(
                lambda: self.db.rpc('increment_usage', {
                    'p_service': service_name,
                    'p_model': model_string,
                    'p_tokens': total_tokens,
                    'p_cost': float(cost),
                    'p_period_start': period_start.isoformat()
                }).execute()
            )
            
            logger.debug(
                f"Tracked usage for {service_name}/{model_string}: "
                f"{total_tokens} tokens, ${cost:.6f}"
            )
            
        except Exception as e:
            logger.error(f"Failed to track usage: {e}")
    
    def _calculate_cost(
        self, 
        model_string: str, 
        input_tokens: int, 
        output_tokens: int
    ) -> Decimal:
        """
        Calculate cost for token usage.
        
        Args:
            model_string: Model identifier
            input_tokens: Number of input tokens
            output_tokens: Number of output tokens
            
        Returns:
            Estimated cost in USD
        """
        if model_string not in self.COST_TABLE:
            # Unknown model, use a default estimate
            logger.warning(f"Unknown model {model_string}, using default cost estimate")
            costs = {'input': 0.001, 'output': 0.002}  # Conservative estimate
        else:
            costs = self.COST_TABLE[model_string]
        
        # Calculate costs (prices are per 1K tokens)
        input_cost = Decimal(str(costs['input'])) * Decimal(input_tokens) / 1000
        output_cost = Decimal(str(costs['output'])) * Decimal(output_tokens) / 1000
        
        return input_cost + output_cost
    
    async def get_usage_summary(
        self,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None
    ) -> UsageSummary:
        """
        Get usage summary across all services.
        
        Args:
            start_date: Start of period (default: 30 days ago)
            end_date: End of period (default: now)
            
        Returns:
            UsageSummary with aggregated metrics
        """
        # Default to last 30 days
        if not end_date:
            end_date = datetime.utcnow()
        if not start_date:
            start_date = end_date - timedelta(days=30)
        
        try:
            # Query usage data
            query = self.db.table('model_usage').select('*')
            
            if start_date:
                query = query.gte('period_start', start_date.isoformat())
            if end_date:
                query = query.lte('period_end', end_date.isoformat())
            
            result = await asyncio.to_thread(query.execute)
            
            # Aggregate metrics
            summary = UsageSummary()
            
            for row in result.data:
                # Update totals
                summary.total_requests += row['request_count']
                summary.total_tokens += row['total_tokens']
                summary.total_cost += Decimal(str(row['estimated_cost']))
                
                # Aggregate by service
                service = row['service_name']
                if service not in summary.by_service:
                    summary.by_service[service] = {
                        'requests': 0,
                        'tokens': 0,
                        'cost': Decimal('0')
                    }
                summary.by_service[service]['requests'] += row['request_count']
                summary.by_service[service]['tokens'] += row['total_tokens']
                summary.by_service[service]['cost'] += Decimal(str(row['estimated_cost']))
                
                # Aggregate by model
                model = row['model_string']
                if model not in summary.by_model:
                    summary.by_model[model] = {
                        'requests': 0,
                        'tokens': 0,
                        'cost': Decimal('0')
                    }
                summary.by_model[model]['requests'] += row['request_count']
                summary.by_model[model]['tokens'] += row['total_tokens']
                summary.by_model[model]['cost'] += Decimal(str(row['estimated_cost']))
            
            logger.info(
                f"Usage summary: {summary.total_requests} requests, "
                f"{summary.total_tokens} tokens, ${summary.total_cost:.2f}"
            )
            
            return summary
            
        except Exception as e:
            logger.error(f"Failed to get usage summary: {e}")
            return UsageSummary()
    
    async def get_service_usage(
        self,
        service_name: str,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None
    ) -> List[UsageMetrics]:
        """
        Get usage metrics for a specific service.
        
        Args:
            service_name: Name of the service
            start_date: Start of period
            end_date: End of period
            
        Returns:
            List of UsageMetrics
        """
        if not end_date:
            end_date = datetime.utcnow()
        if not start_date:
            start_date = end_date - timedelta(days=7)
        
        try:
            query = (
                self.db.table('model_usage')
                .select('*')
                .eq('service_name', service_name)
            )
            
            if start_date:
                query = query.gte('period_start', start_date.isoformat())
            if end_date:
                query = query.lte('period_end', end_date.isoformat())
            
            result = await asyncio.to_thread(query.execute)
            
            metrics = []
            for row in result.data:
                metrics.append(UsageMetrics(
                    service_name=row['service_name'],
                    model_string=row['model_string'],
                    request_count=row['request_count'],
                    total_tokens=row['total_tokens'],
                    estimated_cost=Decimal(str(row['estimated_cost'])),
                    period_start=datetime.fromisoformat(row['period_start']),
                    period_end=datetime.fromisoformat(row['period_end'])
                ))
            
            return metrics
            
        except Exception as e:
            logger.error(f"Failed to get service usage: {e}")
            return []
    
    async def get_daily_costs(
        self,
        days: int = 7
    ) -> Dict[str, Decimal]:
        """
        Get daily costs for the last N days.
        
        Args:
            days: Number of days to look back
            
        Returns:
            Dict mapping date strings to costs
        """
        end_date = datetime.utcnow()
        start_date = end_date - timedelta(days=days)
        
        try:
            # Use the daily_usage_summary view
            query = f"""
                SELECT date, SUM(total_cost) as daily_cost
                FROM daily_usage_summary
                WHERE date >= '{start_date.date()}'
                GROUP BY date
                ORDER BY date DESC
            """
            
            result = await asyncio.to_thread(
                lambda: self.db.rpc('get_daily_costs', {
                    'start_date': start_date.date().isoformat()
                }).execute()
            )
            
            # If RPC doesn't exist, fall back to direct query
            if not result.data:
                result = await asyncio.to_thread(
                    lambda: self.db.table('model_usage')
                    .select('period_start, estimated_cost')
                    .gte('period_start', start_date.isoformat())
                    .execute()
                )
                
                # Aggregate by day
                daily_costs = {}
                for row in result.data:
                    date = datetime.fromisoformat(row['period_start']).date().isoformat()
                    if date not in daily_costs:
                        daily_costs[date] = Decimal('0')
                    daily_costs[date] += Decimal(str(row['estimated_cost']))
                
                return daily_costs
            
            return {
                row['date']: Decimal(str(row['daily_cost']))
                for row in result.data
            }
            
        except Exception as e:
            logger.error(f"Failed to get daily costs: {e}")
            return {}
    
    async def estimate_monthly_cost(self) -> Decimal:
        """
        Estimate monthly cost based on current usage patterns.
        
        Returns:
            Estimated monthly cost
        """
        # Get last 7 days of usage
        daily_costs = await self.get_daily_costs(days=7)
        
        if not daily_costs:
            return Decimal('0')
        
        # Calculate average daily cost
        total = sum(daily_costs.values())
        avg_daily = total / len(daily_costs)
        
        # Estimate monthly (30 days)
        estimated_monthly = avg_daily * 30
        
        logger.info(f"Estimated monthly cost: ${estimated_monthly:.2f}")
        return estimated_monthly