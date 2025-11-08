"""Sentry error tracking configuration."""

import os

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration


def setup_sentry() -> None:
    """
    Initialize Sentry error tracking for the backend.

    This function configures Sentry to capture errors, performance traces,
    and profiling data from the FastAPI application. It will only initialize
    if a SENTRY_DSN is provided in the environment.

    Environment Variables:
        SENTRY_DSN: Sentry Data Source Name (required for Sentry to be enabled)
        ENVIRONMENT: Deployment environment (default: "development")
        GIT_COMMIT: Git commit hash for release tracking (default: "unknown")

    Performance Sampling:
        - Production: 10% of transactions traced
        - Development: 100% of transactions traced
    """
    sentry_dsn = os.getenv("SENTRY_DSN")
    if not sentry_dsn:
        return

    environment = os.getenv("ENVIRONMENT", "development")

    sentry_sdk.init(
        dsn=sentry_dsn,
        environment=environment,
        traces_sample_rate=0.1 if environment == "production" else 1.0,
        profiles_sample_rate=0.1,
        integrations=[
            StarletteIntegration(transaction_style="endpoint"),
            FastApiIntegration(transaction_style="endpoint"),
        ],
        release=os.getenv("GIT_COMMIT", "unknown"),
    )
