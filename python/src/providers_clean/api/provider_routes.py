"""Providers API router aggregator. Includes per-route modules."""

import logging
from fastapi import APIRouter

# Import per-route routers
from .routes.get_model_config import router as get_model_config_router
from .routes.post_model_config import router as post_model_config_router
from .routes.get_model_configs import router as get_model_configs_router
from .routes.delete_model_config import router as delete_model_config_router

from .routes.post_api_keys import router as post_api_keys_router
from .routes.get_api_keys_providers import router as get_api_keys_providers_router
from .routes.delete_api_key import router as delete_api_key_router
from .routes.post_api_keys_test import router as post_api_keys_test_router

from .routes.get_usage_summary import router as get_usage_summary_router
from .routes.get_usage_daily import router as get_usage_daily_router
from .routes.get_usage_estimate_monthly import router as get_usage_estimate_monthly_router
from .routes.post_usage_track import router as post_usage_track_router

from .routes.get_models_available import router as get_models_available_router
from .routes.get_status import router as get_status_router
from .routes.post_initialize import router as post_initialize_router

from .routes.post_models_sync import router as post_models_sync_router
from .routes.get_models_sync_status import router as get_models_sync_status_router
from .routes.post_models_activate import router as post_models_activate_router
from .routes.post_models_deactivate import router as post_models_deactivate_router
from .routes.post_models_initialize import router as post_models_initialize_router

from .routes.get_services_registry import router as get_services_registry_router
from .routes.post_services_register import router as post_services_register_router
from .routes.get_services_agents import router as get_services_agents_router
from .routes.get_services_backend import router as get_services_backend_router
from .routes.get_service_by_name import router as get_service_by_name_router
from .routes.post_service_deprecate import router as post_service_deprecate_router
from .routes.get_services_registry_statistics import router as get_services_registry_statistics_router
from .routes.post_services_registry_sync import router as post_services_registry_sync_router
from .routes.get_services_registry_validate import router as get_services_registry_validate_router

from .routes.get_providers_list import router as get_providers_list_router
from .routes.get_providers_metadata import router as get_providers_metadata_router
from .routes.get_provider_metadata import router as get_provider_metadata_router

from .routes.post_services_registry_initialize import router as post_services_registry_initialize_router
from .routes.post_bootstrap import router as post_bootstrap_router


logger = logging.getLogger(__name__)
router = APIRouter()

# Include all per-route routers
router.include_router(get_model_config_router)
router.include_router(post_model_config_router)
router.include_router(get_model_configs_router)
router.include_router(delete_model_config_router)

router.include_router(post_api_keys_router)
router.include_router(get_api_keys_providers_router)
router.include_router(delete_api_key_router)
router.include_router(post_api_keys_test_router)

router.include_router(get_usage_summary_router)
router.include_router(get_usage_daily_router)
router.include_router(get_usage_estimate_monthly_router)
router.include_router(post_usage_track_router)

router.include_router(get_models_available_router)
router.include_router(get_status_router)
router.include_router(post_initialize_router)

router.include_router(post_models_sync_router)
router.include_router(get_models_sync_status_router)
router.include_router(post_models_activate_router)
router.include_router(post_models_deactivate_router)
router.include_router(post_models_initialize_router)

router.include_router(get_services_registry_router)
router.include_router(post_services_register_router)
router.include_router(get_services_agents_router)
router.include_router(get_services_backend_router)
router.include_router(get_service_by_name_router)
router.include_router(post_service_deprecate_router)
router.include_router(get_services_registry_statistics_router)
router.include_router(post_services_registry_sync_router)
router.include_router(get_services_registry_validate_router)

router.include_router(get_providers_list_router)
router.include_router(get_providers_metadata_router)
router.include_router(get_provider_metadata_router)

router.include_router(post_services_registry_initialize_router)
router.include_router(post_bootstrap_router)
