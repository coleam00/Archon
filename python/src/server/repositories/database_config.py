"""
Flexible database configuration system with environment-based options.

This module provides a comprehensive configuration system for database connections
with support for multiple environments, connection pooling, retry logic, and
health monitoring.

Features:
- Environment-specific configurations
- Connection pooling settings
- Retry and timeout configuration
- Health monitoring settings
- Validation and error handling
- Configuration inheritance
- Runtime configuration updates
"""

import os
import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Dict, Any, Union, List
from urllib.parse import urlparse


logger = logging.getLogger(__name__)


class DatabaseType(Enum):
    """Supported database types."""
    SUPABASE = "supabase"
    POSTGRESQL = "postgresql"
    MOCK = "mock"


class Environment(Enum):
    """Application environments."""
    DEVELOPMENT = "development"
    TESTING = "testing"
    STAGING = "staging"
    PRODUCTION = "production"


@dataclass
class ConnectionConfig:
    """Database connection configuration."""
    
    # Connection settings
    host: Optional[str] = None
    port: Optional[int] = None
    database: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    
    # Supabase-specific settings
    supabase_url: Optional[str] = None
    supabase_key: Optional[str] = None
    
    # Connection pool settings
    pool_size: int = 10
    max_overflow: int = 20
    pool_timeout: int = 30
    pool_recycle: int = 3600  # Recycle connections after 1 hour
    pool_pre_ping: bool = True  # Verify connections before use
    
    # Timeout settings
    connection_timeout: int = 30
    command_timeout: int = 300
    query_timeout: int = 60
    
    # Retry settings
    retry_attempts: int = 3
    retry_delay: float = 1.0
    retry_backoff: float = 2.0
    retry_max_delay: float = 30.0
    
    # SSL settings
    ssl_required: bool = True
    ssl_cert_path: Optional[str] = None
    ssl_key_path: Optional[str] = None
    ssl_ca_path: Optional[str] = None
    
    # Feature flags
    enable_query_logging: bool = False
    enable_slow_query_logging: bool = True
    slow_query_threshold: float = 1.0  # seconds
    enable_connection_pooling: bool = True
    enable_prepared_statements: bool = True
    
    # Health check settings
    health_check_interval: int = 30  # seconds
    health_check_timeout: int = 5   # seconds
    health_check_retries: int = 2
    
    def __post_init__(self):
        """Validate configuration after initialization."""
        if self.supabase_url and not self.supabase_key:
            raise ValueError("supabase_key is required when supabase_url is provided")
        
        if not self.supabase_url and not all([self.host, self.database]):
            raise ValueError("Either supabase_url or (host + database) must be provided")


@dataclass
class DatabaseConfig:
    """Complete database configuration."""
    
    database_type: DatabaseType
    environment: Environment
    connection: ConnectionConfig
    
    # Repository settings
    repository_cache_enabled: bool = True
    repository_cache_size: int = 1000
    repository_cache_ttl: int = 300  # 5 minutes
    
    # Transaction settings
    default_transaction_timeout: int = 60
    max_transaction_duration: int = 300
    enable_nested_transactions: bool = True
    
    # Migration settings
    auto_migrate: bool = False
    migration_timeout: int = 300
    
    # Monitoring settings
    enable_metrics: bool = True
    metrics_interval: int = 60
    enable_tracing: bool = False
    
    # Development settings
    enable_debug_logging: bool = False
    log_queries: bool = False
    log_query_parameters: bool = False
    
    # Additional metadata
    config_version: str = "1.0.0"
    description: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    
    def validate(self) -> List[str]:
        """
        Validate the complete configuration.
        
        Returns:
            List of validation errors (empty if valid)
        """
        errors = []
        
        # Validate connection config
        try:
            self.connection.__post_init__()
        except ValueError as e:
            errors.append(f"Connection config error: {e}")
        
        # Validate timeouts
        if self.connection.connection_timeout <= 0:
            errors.append("connection_timeout must be positive")
        
        if self.connection.command_timeout <= self.connection.connection_timeout:
            errors.append("command_timeout should be greater than connection_timeout")
        
        # Validate pool settings
        if self.connection.pool_size <= 0:
            errors.append("pool_size must be positive")
        
        if self.connection.max_overflow < 0:
            errors.append("max_overflow cannot be negative")
        
        # Validate retry settings
        if self.connection.retry_attempts < 0:
            errors.append("retry_attempts cannot be negative")
        
        if self.connection.retry_delay <= 0:
            errors.append("retry_delay must be positive")
        
        # Environment-specific validations
        if self.environment == Environment.PRODUCTION:
            if not self.connection.ssl_required:
                errors.append("SSL is required in production environment")
            
            if self.enable_debug_logging:
                errors.append("Debug logging should be disabled in production")
            
            if self.log_queries or self.log_query_parameters:
                errors.append("Query logging should be disabled in production")
        
        return errors
    
    def to_connection_string(self) -> str:
        """
        Generate a connection string from the configuration.
        
        Returns:
            Database connection string
            
        Raises:
            ValueError: If configuration is invalid for connection string generation
        """
        if self.database_type == DatabaseType.SUPABASE:
            if not self.connection.supabase_url:
                raise ValueError("supabase_url is required for Supabase connection string")
            return self.connection.supabase_url
        
        elif self.database_type == DatabaseType.POSTGRESQL:
            if not all([self.connection.host, self.connection.database]):
                raise ValueError("host and database are required for PostgreSQL connection string")
            
            conn_str = f"postgresql://"
            
            if self.connection.username:
                conn_str += self.connection.username
                if self.connection.password:
                    conn_str += f":{self.connection.password}"
                conn_str += "@"
            
            conn_str += self.connection.host
            
            if self.connection.port:
                conn_str += f":{self.connection.port}"
            
            conn_str += f"/{self.connection.database}"
            
            # Add SSL parameters
            if self.connection.ssl_required:
                conn_str += "?sslmode=require"
            
            return conn_str
        
        else:
            raise ValueError(f"Unsupported database type: {self.database_type}")


class DatabaseConfigManager:
    """
    Manager for database configurations with environment-based loading.
    """
    
    def __init__(self):
        """Initialize the configuration manager."""
        self._configs: Dict[Environment, DatabaseConfig] = {}
        self._current_environment: Optional[Environment] = None
    
    def load_from_environment(self, environment: Optional[Environment] = None) -> DatabaseConfig:
        """
        Load database configuration from environment variables.
        
        Args:
            environment: Target environment (defaults to auto-detection)
            
        Returns:
            Loaded database configuration
            
        Raises:
            ValueError: If configuration is invalid
        """
        if environment is None:
            environment = self._detect_environment()
        
        logger.info(f"Loading database configuration for environment: {environment.value}")
        
        # Determine database type
        db_type_str = os.getenv("DATABASE_TYPE", "supabase").lower()
        try:
            db_type = DatabaseType(db_type_str)
        except ValueError:
            raise ValueError(f"Invalid database type: {db_type_str}")
        
        # Load connection configuration
        connection_config = self._load_connection_config(environment, db_type)
        
        # Create database configuration
        config = DatabaseConfig(
            database_type=db_type,
            environment=environment,
            connection=connection_config,
            
            # Load other settings from environment
            repository_cache_enabled=self._get_bool_env("REPOSITORY_CACHE_ENABLED", True),
            repository_cache_size=self._get_int_env("REPOSITORY_CACHE_SIZE", 1000),
            repository_cache_ttl=self._get_int_env("REPOSITORY_CACHE_TTL", 300),
            
            default_transaction_timeout=self._get_int_env("DEFAULT_TRANSACTION_TIMEOUT", 60),
            max_transaction_duration=self._get_int_env("MAX_TRANSACTION_DURATION", 300),
            enable_nested_transactions=self._get_bool_env("ENABLE_NESTED_TRANSACTIONS", True),
            
            auto_migrate=self._get_bool_env("AUTO_MIGRATE", False),
            migration_timeout=self._get_int_env("MIGRATION_TIMEOUT", 300),
            
            enable_metrics=self._get_bool_env("ENABLE_DATABASE_METRICS", True),
            metrics_interval=self._get_int_env("DATABASE_METRICS_INTERVAL", 60),
            enable_tracing=self._get_bool_env("ENABLE_DATABASE_TRACING", False),
            
            enable_debug_logging=self._get_bool_env("ENABLE_DATABASE_DEBUG", False),
            log_queries=self._get_bool_env("LOG_DATABASE_QUERIES", False),
            log_query_parameters=self._get_bool_env("LOG_QUERY_PARAMETERS", False),
            
            description=os.getenv("DATABASE_CONFIG_DESCRIPTION"),
            tags=self._get_list_env("DATABASE_CONFIG_TAGS", [])
        )
        
        # Validate configuration
        errors = config.validate()
        if errors:
            error_msg = f"Database configuration validation failed:\n" + "\n".join(f"- {error}" for error in errors)
            raise ValueError(error_msg)
        
        # Cache configuration
        self._configs[environment] = config
        self._current_environment = environment
        
        logger.info(f"Successfully loaded database configuration for {environment.value}")
        return config
    
    def _detect_environment(self) -> Environment:
        """
        Detect the current environment from environment variables.
        
        Returns:
            Detected environment
        """
        env_str = os.getenv("ENVIRONMENT", os.getenv("ENV", "development")).lower()
        
        env_mapping = {
            "dev": Environment.DEVELOPMENT,
            "development": Environment.DEVELOPMENT,
            "test": Environment.TESTING,
            "testing": Environment.TESTING,
            "stage": Environment.STAGING,
            "staging": Environment.STAGING,
            "prod": Environment.PRODUCTION,
            "production": Environment.PRODUCTION
        }
        
        return env_mapping.get(env_str, Environment.DEVELOPMENT)
    
    def _load_connection_config(self, environment: Environment, db_type: DatabaseType) -> ConnectionConfig:
        """
        Load connection configuration from environment variables.
        
        Args:
            environment: Target environment
            db_type: Database type
            
        Returns:
            Connection configuration
        """
        # Base configuration
        config = ConnectionConfig(
            # Pool settings with environment-specific defaults
            pool_size=self._get_int_env("DB_POOL_SIZE", self._get_default_pool_size(environment)),
            max_overflow=self._get_int_env("DB_MAX_OVERFLOW", 20),
            pool_timeout=self._get_int_env("DB_POOL_TIMEOUT", 30),
            pool_recycle=self._get_int_env("DB_POOL_RECYCLE", 3600),
            pool_pre_ping=self._get_bool_env("DB_POOL_PRE_PING", True),
            
            # Timeout settings
            connection_timeout=self._get_int_env("DB_CONNECTION_TIMEOUT", 30),
            command_timeout=self._get_int_env("DB_COMMAND_TIMEOUT", 300),
            query_timeout=self._get_int_env("DB_QUERY_TIMEOUT", 60),
            
            # Retry settings
            retry_attempts=self._get_int_env("DB_RETRY_ATTEMPTS", 3),
            retry_delay=self._get_float_env("DB_RETRY_DELAY", 1.0),
            retry_backoff=self._get_float_env("DB_RETRY_BACKOFF", 2.0),
            retry_max_delay=self._get_float_env("DB_RETRY_MAX_DELAY", 30.0),
            
            # SSL settings
            ssl_required=self._get_bool_env("DB_SSL_REQUIRED", environment == Environment.PRODUCTION),
            ssl_cert_path=os.getenv("DB_SSL_CERT_PATH"),
            ssl_key_path=os.getenv("DB_SSL_KEY_PATH"),
            ssl_ca_path=os.getenv("DB_SSL_CA_PATH"),
            
            # Feature flags
            enable_query_logging=self._get_bool_env("DB_LOG_QUERIES", environment == Environment.DEVELOPMENT),
            enable_slow_query_logging=self._get_bool_env("DB_LOG_SLOW_QUERIES", True),
            slow_query_threshold=self._get_float_env("DB_SLOW_QUERY_THRESHOLD", 1.0),
            enable_connection_pooling=self._get_bool_env("DB_ENABLE_POOLING", True),
            enable_prepared_statements=self._get_bool_env("DB_ENABLE_PREPARED_STATEMENTS", True),
            
            # Health check settings
            health_check_interval=self._get_int_env("DB_HEALTH_CHECK_INTERVAL", 30),
            health_check_timeout=self._get_int_env("DB_HEALTH_CHECK_TIMEOUT", 5),
            health_check_retries=self._get_int_env("DB_HEALTH_CHECK_RETRIES", 2)
        )
        
        # Load database-specific settings
        if db_type == DatabaseType.SUPABASE:
            config.supabase_url = os.getenv("SUPABASE_URL")
            config.supabase_key = os.getenv("SUPABASE_SERVICE_KEY")
            
            if not config.supabase_url:
                raise ValueError("SUPABASE_URL environment variable is required")
            if not config.supabase_key:
                raise ValueError("SUPABASE_SERVICE_KEY environment variable is required")
        
        elif db_type == DatabaseType.POSTGRESQL:
            config.host = os.getenv("DB_HOST", "localhost")
            config.port = self._get_int_env("DB_PORT", 5432)
            config.database = os.getenv("DB_DATABASE", os.getenv("DB_NAME"))
            config.username = os.getenv("DB_USERNAME", os.getenv("DB_USER"))
            config.password = os.getenv("DB_PASSWORD", os.getenv("DB_PASS"))
        
        return config
    
    def _get_default_pool_size(self, environment: Environment) -> int:
        """Get default pool size based on environment."""
        defaults = {
            Environment.DEVELOPMENT: 5,
            Environment.TESTING: 2,
            Environment.STAGING: 10,
            Environment.PRODUCTION: 20
        }
        return defaults.get(environment, 10)
    
    def _get_bool_env(self, key: str, default: bool = False) -> bool:
        """Get boolean value from environment variable."""
        value = os.getenv(key)
        if value is None:
            return default
        return value.lower() in ("true", "1", "yes", "on")
    
    def _get_int_env(self, key: str, default: int = 0) -> int:
        """Get integer value from environment variable."""
        value = os.getenv(key)
        if value is None:
            return default
        try:
            return int(value)
        except ValueError:
            logger.warning(f"Invalid integer value for {key}: {value}, using default: {default}")
            return default
    
    def _get_float_env(self, key: str, default: float = 0.0) -> float:
        """Get float value from environment variable."""
        value = os.getenv(key)
        if value is None:
            return default
        try:
            return float(value)
        except ValueError:
            logger.warning(f"Invalid float value for {key}: {value}, using default: {default}")
            return default
    
    def _get_list_env(self, key: str, default: List[str]) -> List[str]:
        """Get list value from environment variable (comma-separated)."""
        value = os.getenv(key)
        if value is None:
            return default
        return [item.strip() for item in value.split(",") if item.strip()]
    
    def get_config(self, environment: Optional[Environment] = None) -> Optional[DatabaseConfig]:
        """
        Get cached configuration for an environment.
        
        Args:
            environment: Target environment (defaults to current)
            
        Returns:
            Cached configuration or None if not loaded
        """
        if environment is None:
            environment = self._current_environment
        
        if environment is None:
            return None
        
        return self._configs.get(environment)
    
    def get_current_config(self) -> Optional[DatabaseConfig]:
        """
        Get the current active configuration.
        
        Returns:
            Current configuration or None if not set
        """
        return self.get_config()
    
    def list_configs(self) -> Dict[Environment, DatabaseConfig]:
        """
        Get all loaded configurations.
        
        Returns:
            Dictionary of all loaded configurations
        """
        return self._configs.copy()
    
    def clear_cache(self):
        """Clear all cached configurations."""
        self._configs.clear()
        self._current_environment = None
        logger.info("Cleared database configuration cache")


# Global configuration manager instance
_config_manager = DatabaseConfigManager()


def get_config_manager() -> DatabaseConfigManager:
    """Get the global database configuration manager."""
    return _config_manager


def load_database_config(environment: Optional[Environment] = None) -> DatabaseConfig:
    """
    Load database configuration for an environment.
    
    Args:
        environment: Target environment (defaults to auto-detection)
        
    Returns:
        Loaded database configuration
        
    Raises:
        ValueError: If configuration is invalid
    """
    return _config_manager.load_from_environment(environment)


def get_current_database_config() -> Optional[DatabaseConfig]:
    """
    Get the current active database configuration.
    
    Returns:
        Current configuration or None if not loaded
    """
    return _config_manager.get_current_config()