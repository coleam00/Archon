"""
Anti-Bot Detection and Stealth Crawling System

Advanced stealth crawling capabilities to bypass anti-bot measures
commonly employed by e-commerce websites.

Features:
- User agent rotation and browser fingerprinting
- Request timing randomization and human-like patterns
- Cloudflare and bot detection bypass
- Session management and cookie handling
- Proxy rotation support
- Captcha detection and handling
"""

import asyncio
import json
import random
import time
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field
import logging

from ...config.logfire_config import get_logger, safe_logfire_info, safe_logfire_error

logger = get_logger(__name__)


@dataclass
class StealthConfig:
    """Configuration for stealth crawling."""
    rotate_user_agents: bool = True
    randomize_timing: bool = True
    use_proxy_rotation: bool = False
    bypass_cloudflare: bool = True
    handle_captcha: bool = True
    max_retries: int = 3
    base_delay: float = 2.0
    delay_variance: float = 1.0
    
    # Advanced fingerprinting
    spoof_timezone: bool = True
    spoof_screen_resolution: bool = True
    disable_webrtc: bool = True
    randomize_canvas: bool = True


@dataclass
class BotDetection:
    """Bot detection result."""
    is_blocked: bool
    detection_type: str  # "captcha", "cloudflare", "rate_limit", "ip_ban"
    confidence: float
    bypass_success: bool = False
    retry_recommended: bool = True


class UserAgentRotator:
    """Manages user agent rotation for stealth crawling."""
    
    def __init__(self):
        self.user_agents = [
            # Chrome (Windows)
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
            # Chrome (macOS)
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            # Firefox
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
            # Safari
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
            # Edge
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
        ]
    
    def get_random_user_agent(self) -> str:
        """Get a random user agent."""
        return random.choice(self.user_agents)
    
    def get_matching_headers(self, user_agent: str) -> Dict[str, str]:
        """Get headers that match the user agent."""
        base_headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
            "DNT": "1",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none"
        }
        
        if "Chrome" in user_agent:
            base_headers.update({
                "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"' if "Windows" in user_agent else '"macOS"'
            })
        
        return base_headers


class BotDetector:
    """Detects various anti-bot measures."""
    
    def __init__(self):
        self.detection_patterns = {
            "cloudflare": [
                "checking your browser", "cloudflare", "cf-browser-verification",
                "ray id", "performance & security by cloudflare"
            ],
            "captcha": [
                "captcha", "recaptcha", "hcaptcha", "prove you're human",
                "verify you are human", "security check"
            ],
            "rate_limit": [
                "too many requests", "rate limit", "slow down",
                "temporarily blocked", "try again later"
            ],
            "ip_ban": [
                "access denied", "forbidden", "blocked",
                "your ip has been banned", "unauthorized access"
            ]
        }
    
    async def detect_bot_blocking(self, html_content: str, status_code: int) -> BotDetection:
        """Detect if the page indicates bot blocking."""
        
        if not html_content:
            return BotDetection(
                is_blocked=True,
                detection_type="network_error",
                confidence=0.9
            )
        
        html_lower = html_content.lower()
        
        # Check status codes
        if status_code in [403, 429, 503]:
            detection_type = "rate_limit" if status_code == 429 else "ip_ban"
            return BotDetection(
                is_blocked=True,
                detection_type=detection_type,
                confidence=0.8
            )
        
        # Check content patterns
        for detection_type, patterns in self.detection_patterns.items():
            matches = sum(1 for pattern in patterns if pattern in html_lower)
            if matches >= 2:  # Multiple indicators
                confidence = min(0.9, matches * 0.3)
                return BotDetection(
                    is_blocked=True,
                    detection_type=detection_type,
                    confidence=confidence
                )
        
        return BotDetection(
            is_blocked=False,
            detection_type="none",
            confidence=0.0
        )


class StealthCrawler:
    """Main stealth crawling implementation."""
    
    def __init__(self, config: StealthConfig, crawler=None):
        self.config = config
        self.crawler = crawler
        self.user_agent_rotator = UserAgentRotator()
        self.bot_detector = BotDetector()
        
        # Session state
        self.session_cookies = {}
        self.request_history = []
    
    async def stealth_crawl(
        self,
        url: str,
        max_retries: Optional[int] = None,
        custom_headers: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        """
        Perform stealth crawling with anti-bot measures.
        
        Args:
            url: URL to crawl
            max_retries: Maximum retry attempts
            custom_headers: Additional headers
            
        Returns:
            Crawling result with success status and content
        """
        
        max_retries = max_retries or self.config.max_retries
        
        for attempt in range(max_retries + 1):
            try:
                # Prepare stealth configuration
                stealth_headers = await self._prepare_stealth_headers(url, custom_headers)
                browser_config = await self._prepare_browser_config()
                
                # Add random delay
                if attempt > 0 and self.config.randomize_timing:
                    delay = self.config.base_delay + random.uniform(0, self.config.delay_variance)
                    await asyncio.sleep(delay)
                
                # Perform crawl
                if self.crawler:
                    result = await self.crawler.arun(
                        url=url,
                        headers=stealth_headers,
                        timeout=45000,
                        delay_before_return_html=2.0,
                        **browser_config
                    )
                    
                    if result.success:
                        # Check for bot detection
                        detection = await self.bot_detector.detect_bot_blocking(
                            result.cleaned_html or result.html,
                            200  # Assume success status
                        )
                        
                        if not detection.is_blocked:
                            # Success!
                            self._update_session_state(url, stealth_headers)
                            return {
                                "success": True,
                                "html_content": result.cleaned_html or result.html,
                                "url": url,
                                "attempt": attempt + 1,
                                "detection": detection
                            }
                        else:
                            # Bot detected, try bypass
                            if detection.detection_type == "cloudflare" and self.config.bypass_cloudflare:
                                bypass_result = await self._bypass_cloudflare(url, stealth_headers)
                                if bypass_result.get("success"):
                                    return bypass_result
                            
                            safe_logfire_error(f"Bot detected | url={url} | type={detection.detection_type}")
                            
                    else:
                        safe_logfire_error(f"Crawl failed | url={url} | error={result.error_message}")
                
            except Exception as e:
                safe_logfire_error(f"Stealth crawl error | url={url} | attempt={attempt + 1} | error={str(e)}")
        
        # All attempts failed
        return {
            "success": False,
            "error": f"All {max_retries + 1} stealth crawling attempts failed",
            "url": url
        }
    
    async def _prepare_stealth_headers(
        self,
        url: str,
        custom_headers: Optional[Dict[str, str]]
    ) -> Dict[str, str]:
        """Prepare headers for stealth crawling."""
        
        headers = {}
        
        # Get user agent
        if self.config.rotate_user_agents:
            user_agent = self.user_agent_rotator.get_random_user_agent()
            headers.update(self.user_agent_rotator.get_matching_headers(user_agent))
        
        # Add referer for natural browsing
        if len(self.request_history) > 0:
            headers["Referer"] = self.request_history[-1]["url"]
        
        # Custom headers override
        if custom_headers:
            headers.update(custom_headers)
        
        return headers
    
    async def _prepare_browser_config(self) -> Dict[str, Any]:
        """Prepare browser configuration for stealth."""
        
        config = {}
        
        if self.config.spoof_screen_resolution:
            resolutions = ["1920x1080", "1366x768", "1536x864", "1440x900"]
            config["viewport_width"], config["viewport_height"] = map(
                int, random.choice(resolutions).split('x')
            )
        
        # Additional browser args for stealth
        extra_args = [
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
            "--no-sandbox",
            "--disable-gpu"
        ]
        
        if self.config.disable_webrtc:
            extra_args.append("--disable-webrtc")
        
        config["extra_args"] = extra_args
        
        return config
    
    async def _bypass_cloudflare(
        self,
        url: str,
        headers: Dict[str, str]
    ) -> Dict[str, Any]:
        """Attempt to bypass Cloudflare protection."""
        
        try:
            # Wait longer for Cloudflare challenge
            if self.crawler:
                result = await self.crawler.arun(
                    url=url,
                    headers=headers,
                    timeout=60000,  # Longer timeout
                    delay_before_return_html=8.0,  # Wait for challenge
                    wait_for="networkidle"  # Wait for all network activity
                )
                
                if result.success:
                    # Check if bypass succeeded
                    detection = await self.bot_detector.detect_bot_blocking(
                        result.cleaned_html or result.html,
                        200
                    )
                    
                    if not detection.is_blocked:
                        safe_logfire_info(f"Cloudflare bypass successful | url={url}")
                        return {
                            "success": True,
                            "html_content": result.cleaned_html or result.html,
                            "url": url,
                            "bypass_method": "cloudflare_wait"
                        }
            
            return {"success": False, "error": "Cloudflare bypass failed"}
            
        except Exception as e:
            safe_logfire_error(f"Cloudflare bypass error | url={url} | error={str(e)}")
            return {"success": False, "error": f"Bypass error: {str(e)}"}
    
    def _update_session_state(self, url: str, headers: Dict[str, str]):
        """Update session state for maintaining consistency."""
        
        # Add to request history
        self.request_history.append({
            "url": url,
            "timestamp": time.time(),
            "user_agent": headers.get("User-Agent")
        })
        
        # Keep history manageable
        if len(self.request_history) > 10:
            self.request_history.pop(0)


class ProxyRotator:
    """Handles proxy rotation for stealth crawling."""
    
    def __init__(self, proxy_list: Optional[List[str]] = None):
        self.proxies = proxy_list or []
        self.current_proxy_index = 0
        self.failed_proxies = set()
    
    def get_next_proxy(self) -> Optional[str]:
        """Get next available proxy."""
        if not self.proxies:
            return None
        
        # Find working proxy
        attempts = 0
        while attempts < len(self.proxies):
            proxy = self.proxies[self.current_proxy_index]
            self.current_proxy_index = (self.current_proxy_index + 1) % len(self.proxies)
            
            if proxy not in self.failed_proxies:
                return proxy
            
            attempts += 1
        
        return None  # No working proxies
    
    def mark_proxy_failed(self, proxy: str):
        """Mark proxy as failed."""
        self.failed_proxies.add(proxy)
    
    def reset_failed_proxies(self):
        """Reset failed proxy list."""
        self.failed_proxies.clear()


# Factory function
def create_stealth_crawler(crawler=None, **config_kwargs) -> StealthCrawler:
    """Create stealth crawler with configuration."""
    
    config = StealthConfig(**config_kwargs)
    return StealthCrawler(config, crawler)


# Global instance
_stealth_crawler = None


def get_stealth_crawler(crawler=None) -> StealthCrawler:
    """Get global stealth crawler instance."""
    global _stealth_crawler
    if _stealth_crawler is None:
        _stealth_crawler = create_stealth_crawler(crawler)
    return _stealth_crawler