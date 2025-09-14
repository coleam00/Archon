"""
Crawling Mode Registry

Registry system for managing and instantiating different crawling modes.
Provides factory pattern for creating mode instances and managing configurations.
"""

from typing import Dict, Type, Optional, List
from .base import BaseCrawlMode, CrawlModeConfig


class ModeRegistry:
    """Registry for crawling mode implementations."""
    
    _modes: Dict[str, Type[BaseCrawlMode]] = {}
    _configs: Dict[str, CrawlModeConfig] = {}
    
    @classmethod
    def register(cls, name: str, mode_class: Type[BaseCrawlMode]):
        """Register a crawling mode implementation."""
        if not issubclass(mode_class, BaseCrawlMode):
            raise ValueError(f"Mode class {mode_class} must inherit from BaseCrawlMode")
        
        cls._modes[name] = mode_class
    
    @classmethod
    def get_mode_class(cls, name: str) -> Optional[Type[BaseCrawlMode]]:
        """Get a registered mode class by name."""
        return cls._modes.get(name)
    
    @classmethod
    def create_mode(cls, name: str, config: Optional[CrawlModeConfig] = None) -> Optional[BaseCrawlMode]:
        """Create an instance of a crawling mode."""
        mode_class = cls._modes.get(name)
        if not mode_class:
            return None
        
        if config is None:
            config = cls._configs.get(name) or CrawlModeConfig(mode_name=name)
        
        return mode_class(config)
    
    @classmethod
    def list_modes(cls) -> List[str]:
        """List all registered mode names."""
        return list(cls._modes.keys())
    
    @classmethod
    def set_config(cls, name: str, config: CrawlModeConfig):
        """Set configuration for a mode."""
        cls._configs[name] = config
    
    @classmethod
    def get_config(cls, name: str) -> Optional[CrawlModeConfig]:
        """Get configuration for a mode."""
        return cls._configs.get(name)
    
    @classmethod
    def is_registered(cls, name: str) -> bool:
        """Check if a mode is registered."""
        return name in cls._modes


# Convenience functions
def register_mode(name: str, mode_class: Type[BaseCrawlMode]):
    """Register a crawling mode."""
    ModeRegistry.register(name, mode_class)


def get_mode(name: str, config: Optional[CrawlModeConfig] = None) -> Optional[BaseCrawlMode]:
    """Get an instance of a crawling mode."""
    return ModeRegistry.create_mode(name, config)


def list_available_modes() -> List[str]:
    """List all available crawling modes."""
    return ModeRegistry.list_modes()


def set_mode_config(name: str, config: CrawlModeConfig):
    """Set configuration for a crawling mode."""
    ModeRegistry.set_config(name, config)