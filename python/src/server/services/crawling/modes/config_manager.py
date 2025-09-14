"""
Configuration Manager for Crawling Modes

Manages mode-specific configurations with database persistence and runtime settings.
Integrates with Archon's existing settings system for seamless configuration management.
"""

import json
from typing import Dict, Any, Optional, List
from dataclasses import asdict
from datetime import datetime

from .base import CrawlModeConfig, CrawlPriority
from ...utils import get_supabase_client
from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class ConfigManager:
    """Manages configurations for crawling modes."""
    
    def __init__(self, supabase_client=None):
        """Initialize configuration manager."""
        self.supabase = supabase_client or get_supabase_client()
        self._cache: Dict[str, CrawlModeConfig] = {}
        self._loaded = False
    
    async def load_configurations(self) -> Dict[str, CrawlModeConfig]:
        """Load all crawling mode configurations from database."""
        
        try:
            # Query crawling mode settings
            result = self.supabase.table('archon_settings').select('*').like(
                'key', 'CRAWL_MODE_%'
            ).execute()
            
            configs = {}
            
            # Load existing configurations
            for setting in result.data:
                mode_name = setting['key'].replace('CRAWL_MODE_', '').lower()
                
                try:
                    config_data = json.loads(setting['value']) if setting['value'] else {}
                    config = self._dict_to_config(mode_name, config_data)
                    configs[mode_name] = config
                    
                except (json.JSONDecodeError, TypeError) as e:
                    logger.warning(f"Invalid config for mode {mode_name}: {e}")
                    continue
            
            # Create default configurations for missing modes
            default_modes = ['ecommerce', 'blog', 'documentation', 'analytics']
            
            for mode_name in default_modes:
                if mode_name not in configs:
                    config = self._create_default_config(mode_name)
                    configs[mode_name] = config
                    await self.save_configuration(mode_name, config)
            
            self._cache = configs
            self._loaded = True
            
            logger.info(f"Loaded {len(configs)} crawling mode configurations")
            return configs
            
        except Exception as e:
            logger.error(f"Failed to load crawling configurations: {e}")
            return {}
    
    async def get_configuration(self, mode_name: str) -> Optional[CrawlModeConfig]:
        """Get configuration for a specific mode."""
        
        if not self._loaded:
            await self.load_configurations()
        
        config = self._cache.get(mode_name)
        
        if config is None:
            # Create and save default config
            config = self._create_default_config(mode_name)
            await self.save_configuration(mode_name, config)
            self._cache[mode_name] = config
        
        return config
    
    async def save_configuration(self, mode_name: str, config: CrawlModeConfig) -> bool:
        """Save configuration for a specific mode."""
        
        try:
            config_dict = asdict(config)
            config_json = json.dumps(config_dict, default=str)
            
            key = f'CRAWL_MODE_{mode_name.upper()}'
            
            # Upsert the configuration
            result = self.supabase.table('archon_settings').upsert({
                'key': key,
                'value': config_json,
                'is_encrypted': False,
                'category': 'crawling_modes',
                'description': f'Configuration for {mode_name} crawling mode',
                'updated_at': datetime.now().isoformat()
            }).execute()
            
            if result.data:
                self._cache[mode_name] = config
                logger.info(f"Saved configuration for {mode_name} mode")
                return True
            else:
                logger.error(f"Failed to save configuration for {mode_name}")
                return False
                
        except Exception as e:
            logger.error(f"Error saving configuration for {mode_name}: {e}")
            return False
    
    async def update_configuration(
        self, 
        mode_name: str, 
        updates: Dict[str, Any]
    ) -> Optional[CrawlModeConfig]:
        """Update specific fields in a configuration."""
        
        config = await self.get_configuration(mode_name)
        if not config:
            return None
        
        # Update fields
        for key, value in updates.items():
            if hasattr(config, key):
                setattr(config, key, value)
            elif key in config.custom_settings:
                config.custom_settings[key] = value
        
        # Save updated configuration
        success = await self.save_configuration(mode_name, config)
        return config if success else None
    
    async def delete_configuration(self, mode_name: str) -> bool:
        """Delete configuration for a specific mode."""
        
        try:
            key = f'CRAWL_MODE_{mode_name.upper()}'
            
            result = self.supabase.table('archon_settings').delete().eq('key', key).execute()
            
            if mode_name in self._cache:
                del self._cache[mode_name]
            
            logger.info(f"Deleted configuration for {mode_name} mode")
            return True
            
        except Exception as e:
            logger.error(f"Error deleting configuration for {mode_name}: {e}")
            return False
    
    async def list_configurations(self) -> List[str]:
        """List all available mode configurations."""
        
        if not self._loaded:
            await self.load_configurations()
        
        return list(self._cache.keys())
    
    async def export_configurations(self) -> Dict[str, Dict[str, Any]]:
        """Export all configurations as dictionary."""
        
        if not self._loaded:
            await self.load_configurations()
        
        exported = {}
        for mode_name, config in self._cache.items():
            exported[mode_name] = asdict(config)
        
        return exported
    
    async def import_configurations(self, configurations: Dict[str, Dict[str, Any]]) -> bool:
        """Import configurations from dictionary."""
        
        try:
            for mode_name, config_data in configurations.items():
                config = self._dict_to_config(mode_name, config_data)
                await self.save_configuration(mode_name, config)
            
            logger.info(f"Imported {len(configurations)} configurations")
            return True
            
        except Exception as e:
            logger.error(f"Error importing configurations: {e}")
            return False
    
    def _create_default_config(self, mode_name: str) -> CrawlModeConfig:
        """Create default configuration for a mode."""
        
        # Mode-specific defaults
        mode_defaults = {
            'ecommerce': {
                'max_pages': 500,
                'max_depth': 4,
                'concurrent_requests': 3,  # Lower for e-commerce to avoid rate limits
                'delay_between_requests': 2.0,
                'use_random_user_agents': True,
                'bypass_cloudflare': True,
                'custom_settings': {
                    'extract_variants': True,
                    'extract_reviews': True,
                    'track_price_changes': True,
                    'max_images_per_product': 10,
                    'extract_specifications': True,
                }
            },
            'blog': {
                'max_pages': 200,
                'max_depth': 3,
                'concurrent_requests': 5,
                'delay_between_requests': 1.0,
                'custom_settings': {
                    'extract_author': True,
                    'extract_publish_date': True,
                    'extract_tags': True,
                    'extract_comments': False,
                    'min_article_length': 300,
                }
            },
            'documentation': {
                'max_pages': 1000,
                'max_depth': 5,
                'concurrent_requests': 8,
                'delay_between_requests': 0.5,
                'custom_settings': {
                    'extract_code_examples': True,
                    'extract_api_endpoints': True,
                    'follow_internal_links': True,
                    'extract_version_info': True,
                }
            },
            'analytics': {
                'max_pages': 100,
                'max_depth': 2,
                'concurrent_requests': 3,
                'delay_between_requests': 3.0,  # Slower for analytics sites
                'custom_settings': {
                    'extract_metrics': True,
                    'extract_charts': False,  # Complex extraction
                    'wait_for_dynamic_content': True,
                }
            }
        }
        
        defaults = mode_defaults.get(mode_name, {})
        
        return CrawlModeConfig(
            mode_name=mode_name,
            enabled=True,
            priority=CrawlPriority.NORMAL,
            max_pages=defaults.get('max_pages', 100),
            max_depth=defaults.get('max_depth', 3),
            concurrent_requests=defaults.get('concurrent_requests', 5),
            delay_between_requests=defaults.get('delay_between_requests', 1.0),
            max_retries=3,
            retry_delay=2.0,
            backoff_factor=2.0,
            use_random_user_agents=defaults.get('use_random_user_agents', True),
            rotate_proxies=False,
            bypass_cloudflare=defaults.get('bypass_cloudflare', False),
            respect_robots_txt=True,
            min_content_length=100,
            max_content_length=1000000,
            content_filters=[],
            custom_settings=defaults.get('custom_settings', {})
        )
    
    def _dict_to_config(self, mode_name: str, config_dict: Dict[str, Any]) -> CrawlModeConfig:
        """Convert dictionary to CrawlModeConfig."""
        
        # Handle priority enum
        priority_value = config_dict.get('priority', 'normal')
        if isinstance(priority_value, str):
            try:
                priority = CrawlPriority(priority_value)
            except ValueError:
                priority = CrawlPriority.NORMAL
        else:
            priority = priority_value
        
        config_dict['priority'] = priority
        config_dict['mode_name'] = mode_name
        
        # Remove any unknown fields
        valid_fields = {f.name for f in CrawlModeConfig.__dataclass_fields__.values()}
        filtered_dict = {k: v for k, v in config_dict.items() if k in valid_fields}
        
        return CrawlModeConfig(**filtered_dict)


# Global instance
_config_manager = None


def get_config_manager() -> ConfigManager:
    """Get the global configuration manager instance."""
    global _config_manager
    if _config_manager is None:
        _config_manager = ConfigManager()
    return _config_manager