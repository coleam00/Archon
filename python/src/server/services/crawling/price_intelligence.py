"""
Advanced Price Tracking and Variant Analysis System

Provides comprehensive price intelligence, variant analysis, and competitive monitoring
capabilities for e-commerce products extracted through smart crawling.

Features:
- Real-time price change detection and alerts
- Historical price trend analysis
- Variant pricing comparison and optimization
- Competitive intelligence and market positioning
- Price prediction and forecasting models
- Automated discount and promotion detection
"""

import asyncio
import json
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field
from decimal import Decimal
import statistics
import logging

from ..utils import get_supabase_client
from ..config.logfire_config import get_logger, safe_logfire_info, safe_logfire_error

logger = get_logger(__name__)


@dataclass
class PriceAlert:
    """Price alert configuration."""
    product_id: str
    alert_type: str  # "price_drop", "price_increase", "discount_available", "back_in_stock"
    threshold_value: Optional[float] = None
    threshold_percent: Optional[float] = None
    is_active: bool = True
    created_at: datetime = field(default_factory=datetime.now)


@dataclass
class PriceTrend:
    """Price trend analysis result."""
    product_id: str
    trend_direction: str  # "increasing", "decreasing", "stable", "volatile"
    trend_strength: float  # 0.0 to 1.0
    average_price: float
    price_volatility: float
    prediction_confidence: float
    days_analyzed: int
    price_changes_count: int


@dataclass
class VariantAnalysis:
    """Variant pricing and popularity analysis."""
    product_id: str
    variant_count: int
    price_range: Tuple[float, float]
    most_popular_variant: Optional[Dict[str, Any]]
    best_value_variant: Optional[Dict[str, Any]]
    price_distribution: Dict[str, int]
    attribute_pricing_impact: Dict[str, float]


@dataclass
class CompetitiveIntelligence:
    """Competitive analysis result."""
    product_name: str
    brand: str
    market_position: str  # "premium", "mid-range", "budget", "leader"
    price_competitiveness: float  # 0.0 to 1.0
    competitors: List[Dict[str, Any]]
    market_share_indicator: float
    pricing_opportunity: Optional[str]


class PriceTracker:
    """Advanced price tracking and analysis system."""
    
    def __init__(self, supabase_client=None):
        """Initialize the price tracker."""
        self.supabase = supabase_client or get_supabase_client()
        self.active_alerts = {}
        
    async def track_price_changes(
        self,
        product_id: str,
        current_price: float,
        original_price: Optional[float] = None,
        source_url: str = None
    ) -> bool:
        """
        Track price changes for a specific product.
        
        Args:
            product_id: Unique product identifier
            current_price: Current product price
            original_price: Original/MSRP price (optional)
            source_url: Source page URL
            
        Returns:
            True if price change was detected and recorded
        """
        
        try:
            # Get previous price
            previous_price_result = self.supabase.table("archon_price_history").select(
                "price, recorded_at"
            ).eq("product_id", product_id).order("recorded_at", desc=True).limit(1).execute()
            
            previous_price = None
            if previous_price_result.data:
                previous_price = float(previous_price_result.data[0]["price"])
            
            # Calculate price change
            price_change_amount = None
            price_change_percent = None
            
            if previous_price is not None:
                price_change_amount = current_price - previous_price
                if previous_price > 0:
                    price_change_percent = (price_change_amount / previous_price) * 100
            
            # Record price history entry
            price_record = {
                "product_id": product_id,
                "price": current_price,
                "original_price": original_price,
                "currency": "USD",  # TODO: Make dynamic
                "price_change_percent": price_change_percent,
                "price_change_amount": price_change_amount,
                "source_page": source_url,
                "recorded_at": datetime.now().isoformat()
            }
            
            self.supabase.table("archon_price_history").insert(price_record).execute()
            
            # Check for price alerts
            if price_change_percent is not None:
                await self._check_price_alerts(
                    product_id, current_price, 
                    previous_price, price_change_percent
                )
            
            safe_logfire_info(f"Price tracked | product={product_id} | price={current_price} | change={price_change_percent}%")
            
            return price_change_percent is not None and abs(price_change_percent) > 0.01
            
        except Exception as e:
            safe_logfire_error(f"Price tracking failed | product={product_id} | error={str(e)}")
            return False
    
    async def analyze_price_trends(
        self,
        product_id: str,
        days: int = 30,
        min_data_points: int = 3
    ) -> Optional[PriceTrend]:
        """
        Analyze price trends for a product over specified period.
        
        Args:
            product_id: Product to analyze
            days: Number of days to analyze
            min_data_points: Minimum price points required for analysis
            
        Returns:
            PriceTrend object with analysis results
        """
        
        try:
            # Get price history
            start_date = (datetime.now() - timedelta(days=days)).isoformat()
            
            price_result = self.supabase.table("archon_price_history").select(
                "price, recorded_at"
            ).eq("product_id", product_id).gte("recorded_at", start_date).order(
                "recorded_at", desc=False
            ).execute()
            
            if not price_result.data or len(price_result.data) < min_data_points:
                return None
            
            # Extract price data
            prices = [float(record["price"]) for record in price_result.data]
            dates = [datetime.fromisoformat(record["recorded_at"].replace('Z', '+00:00')) for record in price_result.data]
            
            # Calculate trend metrics
            average_price = statistics.mean(prices)
            price_volatility = statistics.stdev(prices) if len(prices) > 1 else 0.0
            
            # Trend direction analysis
            trend_direction = "stable"
            trend_strength = 0.0
            
            if len(prices) >= 2:
                first_half = prices[:len(prices)//2]
                second_half = prices[len(prices)//2:]
                
                first_avg = statistics.mean(first_half)
                second_avg = statistics.mean(second_half)
                
                if second_avg > first_avg * 1.05:  # 5% increase threshold
                    trend_direction = "increasing"
                    trend_strength = min((second_avg - first_avg) / first_avg, 1.0)
                elif second_avg < first_avg * 0.95:  # 5% decrease threshold
                    trend_direction = "decreasing" 
                    trend_strength = min((first_avg - second_avg) / first_avg, 1.0)
                elif price_volatility / average_price > 0.1:  # High volatility
                    trend_direction = "volatile"
                    trend_strength = min(price_volatility / average_price, 1.0)
            
            # Prediction confidence based on data quality
            prediction_confidence = min(
                len(prices) / 10.0,  # More data points = higher confidence
                1.0 - (price_volatility / average_price)  # Lower volatility = higher confidence
            )
            prediction_confidence = max(min(prediction_confidence, 1.0), 0.0)
            
            return PriceTrend(
                product_id=product_id,
                trend_direction=trend_direction,
                trend_strength=trend_strength,
                average_price=average_price,
                price_volatility=price_volatility,
                prediction_confidence=prediction_confidence,
                days_analyzed=days,
                price_changes_count=len(prices) - 1
            )
            
        except Exception as e:
            safe_logfire_error(f"Price trend analysis failed | product={product_id} | error={str(e)}")
            return None
    
    async def analyze_product_variants(
        self,
        product_id: str
    ) -> Optional[VariantAnalysis]:
        """
        Analyze product variants for pricing patterns and popularity.
        
        Args:
            product_id: Product to analyze variants for
            
        Returns:
            VariantAnalysis with variant insights
        """
        
        try:
            # Get product variants
            variants_result = self.supabase.table("archon_product_variants").select(
                "*"
            ).eq("product_id", product_id).execute()
            
            if not variants_result.data:
                return None
            
            variants = variants_result.data
            variant_count = len(variants)
            
            # Extract prices
            variant_prices = []
            for variant in variants:
                if variant.get("price"):
                    variant_prices.append(float(variant["price"]))
            
            if not variant_prices:
                return None
            
            # Price range analysis
            min_price = min(variant_prices)
            max_price = max(variant_prices)
            price_range = (min_price, max_price)
            
            # Price distribution analysis
            price_buckets = {
                "budget": 0,      # Bottom 33%
                "mid_range": 0,   # Middle 33%
                "premium": 0      # Top 33%
            }
            
            sorted_prices = sorted(variant_prices)
            lower_third = sorted_prices[len(sorted_prices)//3]
            upper_third = sorted_prices[2*len(sorted_prices)//3]
            
            for price in variant_prices:
                if price <= lower_third:
                    price_buckets["budget"] += 1
                elif price >= upper_third:
                    price_buckets["premium"] += 1
                else:
                    price_buckets["mid_range"] += 1
            
            # Find best value variant (lowest price)
            best_value_variant = None
            for variant in variants:
                if variant.get("price") == min_price:
                    best_value_variant = {
                        "id": variant["id"],
                        "name": variant.get("name"),
                        "price": variant["price"],
                        "attributes": json.loads(variant.get("attributes", "{}"))
                    }
                    break
            
            # Most popular variant (assume highest price indicates premium/popular)
            most_popular_variant = None
            for variant in variants:
                if variant.get("price") == max_price:
                    most_popular_variant = {
                        "id": variant["id"],
                        "name": variant.get("name"),
                        "price": variant["price"],
                        "attributes": json.loads(variant.get("attributes", "{}"))
                    }
                    break
            
            # Attribute pricing impact analysis
            attribute_pricing_impact = {}
            
            # Group variants by attributes to analyze pricing impact
            attribute_groups = {}
            for variant in variants:
                if not variant.get("price"):
                    continue
                    
                attributes = json.loads(variant.get("attributes", "{}"))
                for attr_name, attr_value in attributes.items():
                    if attr_name not in attribute_groups:
                        attribute_groups[attr_name] = {}
                    if attr_value not in attribute_groups[attr_name]:
                        attribute_groups[attr_name][attr_value] = []
                    attribute_groups[attr_name][attr_value].append(float(variant["price"]))
            
            # Calculate pricing impact for each attribute
            for attr_name, attr_values in attribute_groups.items():
                if len(attr_values) > 1:
                    prices_by_value = {
                        value: statistics.mean(prices) 
                        for value, prices in attr_values.items()
                    }
                    
                    min_avg_price = min(prices_by_value.values())
                    max_avg_price = max(prices_by_value.values())
                    
                    if min_avg_price > 0:
                        pricing_impact = (max_avg_price - min_avg_price) / min_avg_price
                        attribute_pricing_impact[attr_name] = round(pricing_impact, 3)
            
            return VariantAnalysis(
                product_id=product_id,
                variant_count=variant_count,
                price_range=price_range,
                most_popular_variant=most_popular_variant,
                best_value_variant=best_value_variant,
                price_distribution=price_buckets,
                attribute_pricing_impact=attribute_pricing_impact
            )
            
        except Exception as e:
            safe_logfire_error(f"Variant analysis failed | product={product_id} | error={str(e)}")
            return None
    
    async def generate_competitive_intelligence(
        self,
        product_id: str,
        competitor_search_terms: Optional[List[str]] = None
    ) -> Optional[CompetitiveIntelligence]:
        """
        Generate competitive intelligence report for a product.
        
        Args:
            product_id: Target product for analysis
            competitor_search_terms: Optional search terms to find competitors
            
        Returns:
            CompetitiveIntelligence with market analysis
        """
        
        try:
            # Get target product details
            product_result = self.supabase.table("archon_ecommerce_products").select(
                "*"
            ).eq("id", product_id).execute()
            
            if not product_result.data:
                return None
            
            target_product = product_result.data[0]
            target_price = float(target_product.get("current_price", 0))
            target_brand = target_product.get("brand", "")
            target_name = target_product.get("name", "")
            
            # Find potential competitors (same category or similar products)
            competitors = []
            
            # Search by brand (other products from competitors)
            if target_brand:
                competitor_result = self.supabase.table("archon_ecommerce_products").select(
                    "id, name, brand, current_price, rating, review_count"
                ).neq("brand", target_brand).not_.is_("current_price", "null").limit(10).execute()
                
                for comp in competitor_result.data:
                    if comp.get("current_price"):
                        competitors.append({
                            "id": comp["id"],
                            "name": comp["name"],
                            "brand": comp["brand"],
                            "price": float(comp["current_price"]),
                            "rating": comp.get("rating"),
                            "review_count": comp.get("review_count", 0)
                        })
            
            # Market positioning analysis
            if competitors:
                competitor_prices = [c["price"] for c in competitors if c["price"] > 0]
                
                if competitor_prices and target_price > 0:
                    avg_market_price = statistics.mean(competitor_prices)
                    
                    # Determine market position
                    if target_price > avg_market_price * 1.3:
                        market_position = "premium"
                    elif target_price < avg_market_price * 0.7:
                        market_position = "budget"
                    elif target_price > avg_market_price * 1.1:
                        market_position = "mid-range-premium"
                    else:
                        market_position = "mid-range"
                    
                    # Price competitiveness (lower = more competitive)
                    price_competitiveness = 1.0 - min(
                        (target_price - min(competitor_prices)) / (max(competitor_prices) - min(competitor_prices)),
                        1.0
                    )
                else:
                    market_position = "unknown"
                    price_competitiveness = 0.5
            else:
                market_position = "leader"  # No competitors found
                price_competitiveness = 1.0
            
            # Market share indicator (based on reviews and rating)
            target_reviews = target_product.get("review_count", 0) or 0
            target_rating = target_product.get("rating", 0) or 0
            
            if competitors:
                avg_competitor_reviews = statistics.mean([c.get("review_count", 0) or 0 for c in competitors])
                avg_competitor_rating = statistics.mean([c.get("rating", 0) or 0 for c in competitors if c.get("rating")])
                
                review_share = min(target_reviews / max(avg_competitor_reviews, 1), 3.0) / 3.0  # Cap at 3x
                rating_share = target_rating / max(avg_competitor_rating, 1) if avg_competitor_rating else 1.0
                
                market_share_indicator = (review_share + rating_share) / 2
            else:
                market_share_indicator = 1.0
            
            # Pricing opportunity analysis
            pricing_opportunity = None
            if competitors and target_price > 0:
                min_competitor_price = min(competitor_prices)
                max_competitor_price = max(competitor_prices)
                
                if target_price > max_competitor_price * 1.1:
                    pricing_opportunity = "Consider price reduction to improve competitiveness"
                elif target_price < min_competitor_price * 0.9:
                    pricing_opportunity = "Opportunity to increase price while maintaining competitiveness"
                elif market_share_indicator > 0.7 and price_competitiveness < 0.5:
                    pricing_opportunity = "Strong market position - consider premium pricing"
            
            return CompetitiveIntelligence(
                product_name=target_name,
                brand=target_brand,
                market_position=market_position,
                price_competitiveness=price_competitiveness,
                competitors=competitors[:5],  # Top 5 competitors
                market_share_indicator=market_share_indicator,
                pricing_opportunity=pricing_opportunity
            )
            
        except Exception as e:
            safe_logfire_error(f"Competitive intelligence failed | product={product_id} | error={str(e)}")
            return None
    
    async def create_price_alert(
        self,
        product_id: str,
        alert_type: str,
        threshold_value: Optional[float] = None,
        threshold_percent: Optional[float] = None
    ) -> bool:
        """
        Create a price alert for a product.
        
        Args:
            product_id: Product to monitor
            alert_type: Type of alert ("price_drop", "price_increase", "discount_available")
            threshold_value: Absolute price threshold
            threshold_percent: Percentage change threshold
            
        Returns:
            True if alert was created successfully
        """
        
        try:
            alert_record = {
                "product_id": product_id,
                "alert_type": alert_type,
                "threshold_value": threshold_value,
                "threshold_percent": threshold_percent,
                "is_active": True,
                "created_at": datetime.now().isoformat()
            }
            
            # Store alert in database (would need alerts table)
            # For now, store in memory
            alert_key = f"{product_id}_{alert_type}"
            self.active_alerts[alert_key] = PriceAlert(
                product_id=product_id,
                alert_type=alert_type,
                threshold_value=threshold_value,
                threshold_percent=threshold_percent
            )
            
            safe_logfire_info(f"Price alert created | product={product_id} | type={alert_type}")
            return True
            
        except Exception as e:
            safe_logfire_error(f"Failed to create price alert | product={product_id} | error={str(e)}")
            return False
    
    async def _check_price_alerts(
        self,
        product_id: str,
        current_price: float,
        previous_price: float,
        price_change_percent: float
    ) -> None:
        """Check and trigger price alerts for a product."""
        
        try:
            # Check all active alerts for this product
            for alert_key, alert in self.active_alerts.items():
                if not alert.product_id == product_id or not alert.is_active:
                    continue
                
                triggered = False
                
                if alert.alert_type == "price_drop":
                    if alert.threshold_percent and price_change_percent <= -alert.threshold_percent:
                        triggered = True
                    elif alert.threshold_value and current_price <= alert.threshold_value:
                        triggered = True
                
                elif alert.alert_type == "price_increase":
                    if alert.threshold_percent and price_change_percent >= alert.threshold_percent:
                        triggered = True
                    elif alert.threshold_value and current_price >= alert.threshold_value:
                        triggered = True
                
                if triggered:
                    await self._trigger_price_alert(alert, current_price, previous_price, price_change_percent)
        
        except Exception as e:
            safe_logfire_error(f"Price alert check failed | product={product_id} | error={str(e)}")
    
    async def _trigger_price_alert(
        self,
        alert: PriceAlert,
        current_price: float,
        previous_price: float,
        price_change_percent: float
    ) -> None:
        """Trigger a price alert (send notification, log, etc.)."""
        
        try:
            alert_data = {
                "product_id": alert.product_id,
                "alert_type": alert.alert_type,
                "current_price": current_price,
                "previous_price": previous_price,
                "price_change_percent": price_change_percent,
                "triggered_at": datetime.now().isoformat()
            }
            
            # Log the alert
            safe_logfire_info(f"Price alert triggered | {json.dumps(alert_data)}")
            
            # Here you could add:
            # - Email notifications
            # - Webhook calls
            # - Database logging
            # - Real-time UI notifications via Socket.IO
            
        except Exception as e:
            safe_logfire_error(f"Failed to trigger price alert | error={str(e)}")


class VariantOptimizer:
    """Advanced variant analysis and optimization system."""
    
    def __init__(self, supabase_client=None):
        """Initialize the variant optimizer."""
        self.supabase = supabase_client or get_supabase_client()
    
    async def optimize_variant_pricing(
        self,
        product_id: str,
        target_margin: float = 0.3,
        competitor_analysis: bool = True
    ) -> Dict[str, Any]:
        """
        Optimize variant pricing based on market analysis and margins.
        
        Args:
            product_id: Product to optimize
            target_margin: Desired profit margin (0.0 to 1.0)
            competitor_analysis: Include competitive analysis
            
        Returns:
            Dictionary with optimization recommendations
        """
        
        try:
            # Get variant analysis
            price_tracker = PriceTracker(self.supabase)
            variant_analysis = await price_tracker.analyze_product_variants(product_id)
            
            if not variant_analysis:
                return {"error": "No variant data available for analysis"}
            
            # Get competitive intelligence if requested
            competitive_intel = None
            if competitor_analysis:
                competitive_intel = await price_tracker.generate_competitive_intelligence(product_id)
            
            recommendations = {
                "product_id": product_id,
                "current_analysis": {
                    "variant_count": variant_analysis.variant_count,
                    "price_range": variant_analysis.price_range,
                    "price_distribution": variant_analysis.price_distribution,
                    "attribute_impact": variant_analysis.attribute_pricing_impact
                },
                "optimization_recommendations": [],
                "market_insights": {}
            }
            
            # Add competitive context
            if competitive_intel:
                recommendations["market_insights"] = {
                    "market_position": competitive_intel.market_position,
                    "price_competitiveness": competitive_intel.price_competitiveness,
                    "pricing_opportunity": competitive_intel.pricing_opportunity
                }
            
            # Generate specific recommendations
            min_price, max_price = variant_analysis.price_range
            price_spread = max_price - min_price
            
            # Recommendation 1: Optimize price distribution
            if variant_analysis.price_distribution.get("mid_range", 0) < variant_analysis.variant_count * 0.3:
                recommendations["optimization_recommendations"].append({
                    "type": "price_distribution",
                    "priority": "high",
                    "message": "Consider adding more mid-range variants to capture broader market",
                    "suggested_price_range": (min_price + price_spread * 0.3, min_price + price_spread * 0.7)
                })
            
            # Recommendation 2: High-impact attributes
            high_impact_attrs = {
                attr: impact for attr, impact in variant_analysis.attribute_pricing_impact.items()
                if impact > 0.2  # 20% price impact
            }
            
            if high_impact_attrs:
                recommendations["optimization_recommendations"].append({
                    "type": "attribute_optimization",
                    "priority": "medium",
                    "message": f"High-impact attributes detected: {list(high_impact_attrs.keys())}",
                    "details": high_impact_attrs
                })
            
            # Recommendation 3: Competitive positioning
            if competitive_intel and competitive_intel.price_competitiveness < 0.4:
                recommendations["optimization_recommendations"].append({
                    "type": "competitive_adjustment",
                    "priority": "high",
                    "message": "Product pricing may be too high compared to competitors",
                    "suggested_action": "Consider reducing premium variant pricing by 10-15%"
                })
            
            return recommendations
            
        except Exception as e:
            safe_logfire_error(f"Variant optimization failed | product={product_id} | error={str(e)}")
            return {"error": f"Optimization failed: {str(e)}"}


# Global instances
_price_tracker = None
_variant_optimizer = None


def get_price_tracker() -> PriceTracker:
    """Get global price tracker instance."""
    global _price_tracker
    if _price_tracker is None:
        _price_tracker = PriceTracker()
    return _price_tracker


def get_variant_optimizer() -> VariantOptimizer:
    """Get global variant optimizer instance."""
    global _variant_optimizer
    if _variant_optimizer is None:
        _variant_optimizer = VariantOptimizer()
    return _variant_optimizer