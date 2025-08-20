"""
Database management API endpoints for Archon

Handles:
- Database status checking
- Setup SQL content delivery
- Database initialization verification
"""

import os
import time
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config.config import load_database_config
from ..config.logfire_config import get_logger
from ..services.credential_service import credential_service
from ..services.database_exceptions import (
    DatabaseConfigurationError,
    DatabaseConnectionError,
    DatabaseNotInitializedException,
)

logger = get_logger(__name__)

router = APIRouter(prefix="/api/database", tags=["database"])


class DatabaseStatus(BaseModel):
    """Database status response model."""

    initialized: bool
    setup_required: bool
    message: str


class SetupSQLResponse(BaseModel):
    """Setup SQL content response model."""

    sql_content: str
    project_id: str | None
    sql_editor_url: str | None


@router.get("/status", response_model=DatabaseStatus)
async def get_database_status():
    """Check if the database is properly initialized with detailed error reporting."""
    correlation_id = str(uuid.uuid4())
    logger.info("Database status check started", extra={"correlation_id": correlation_id})

    try:
        if not credential_service.is_supabase_configured():
            missing_vars = []
            if not os.getenv("SUPABASE_URL"):
                missing_vars.append("SUPABASE_URL")
            if not os.getenv("SUPABASE_SERVICE_KEY"):
                missing_vars.append("SUPABASE_SERVICE_KEY")

            logger.debug(
                f"Database status check: Supabase environment variables not configured - missing {missing_vars}",
                extra={"correlation_id": correlation_id},
            )
            return DatabaseStatus(
                initialized=False,
                setup_required=True,
                message=f"Supabase environment variables not configured. Missing: {', '.join(missing_vars)}. Please add them to your .env file and restart the server.",
            )

        await credential_service.load_all_credentials()

        if credential_service.database_tables_exist():
            logger.debug(
                "Database status check: tables exist, credentials loaded successfully",
                extra={"correlation_id": correlation_id},
            )
            return DatabaseStatus(initialized=True, setup_required=False, message="Database is properly initialized")
        else:
            logger.debug(
                "Database status check: tables not found, setup required", extra={"correlation_id": correlation_id}
            )
            return DatabaseStatus(
                initialized=False, setup_required=True, message="Database tables are missing and need to be created"
            )

    except DatabaseNotInitializedException as e:
        logger.debug(f"Database not initialized: {e}", extra={"correlation_id": correlation_id})
        return DatabaseStatus(
            initialized=False, setup_required=True, message="Database tables are missing and need to be created"
        )

    except DatabaseConfigurationError as e:
        logger.info(
            f"Database configuration incomplete: {e}",
            extra={"correlation_id": correlation_id, "error_context": e.to_dict()},
        )
        return DatabaseStatus(initialized=False, setup_required=True, message=str(e))

    except DatabaseConnectionError as e:
        error_response = {
            "error": "Database connection failed",
            "context": e.context,
            "correlation_id": correlation_id,
            "remediation": e.remediation,
            "timestamp": datetime.now().isoformat(),
        }

        logger.error(
            f"Database status check failed with connection error: {e}",
            extra={"correlation_id": correlation_id, "error_context": e.context},
            exc_info=True,
        )

        raise HTTPException(status_code=500, detail=error_response) from e

    except Exception as e:
        error_context = {
            "error_type": type(e).__name__,
            "correlation_id": correlation_id,
            "timestamp": datetime.now().isoformat(),
        }

        logger.error(f"Unexpected error in database status check: {e}", extra=error_context, exc_info=True)

        raise HTTPException(
            status_code=500,
            detail={"error": f"Unexpected database status check failure: {e}", "context": error_context},
        ) from e


@router.get("/setup-sql", response_model=SetupSQLResponse)
async def get_setup_sql():
    """Get the SQL content for database setup and related URLs."""
    try:
        config = load_database_config()
        sql_file_path = Path(config.setup_sql_path)
        logger.debug(f"Looking for setup SQL file at configured path: {sql_file_path}")

        sql_content = None

        if sql_file_path.exists():
            try:
                with open(sql_file_path, encoding="utf-8") as f:
                    sql_content = f.read()

                if not sql_content or not sql_content.strip():
                    logger.error(f"Setup SQL file at {sql_file_path} exists but is empty")
                    raise HTTPException(status_code=500, detail="Setup SQL file is empty")
                else:
                    logger.debug(f"Successfully read {len(sql_content)} characters from setup SQL file")
            except (PermissionError, OSError) as file_error:
                logger.error(f"Failed to read setup SQL file at {sql_file_path}: {file_error}")
                raise HTTPException(
                    status_code=500, detail=f"Failed to get setup SQL: {str(file_error)}"
                ) from file_error
            except UnicodeDecodeError as decode_error:
                logger.warning(
                    f"Failed to decode setup SQL file at {sql_file_path}: {decode_error}, falling back to embedded SQL"
                )
                sql_content = None

        if sql_content is None:
            error_msg = "Setup SQL file not found"
            logger.error(error_msg)
            raise HTTPException(status_code=500, detail=error_msg)

        supabase_url = os.getenv("SUPABASE_URL")
        project_id = None
        sql_editor_url = None

        if supabase_url:
            import re

            match = re.search(r"https://([^.]+)\.supabase\.co", supabase_url)
            if match:
                project_id = match.group(1)
                sql_editor_url = f"https://supabase.com/dashboard/project/{project_id}/sql/new"
                logger.debug(f"Generated SQL editor URL for project {project_id}")

        return SetupSQLResponse(sql_content=sql_content, project_id=project_id, sql_editor_url=sql_editor_url)

    except Exception as e:
        logger.error(f"Failed to get setup SQL: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get setup SQL: {str(e)}") from e


@router.post("/verify-setup")
async def verify_database_setup():
    """Verify that the database has been properly set up after running SQL."""
    correlation_id = str(uuid.uuid4())
    logger.info("Database setup verification started", extra={"correlation_id": correlation_id})

    try:
        credential_service.reset_cache()
        credential_service.force_database_reload()

        verification_start = time.time()
        await credential_service.load_all_credentials()
        verification_duration = time.time() - verification_start

        if credential_service.database_tables_exist():
            from ..main import update_database_initialized

            update_database_initialized(True)

            logger.info(
                "Database setup verified successfully",
                extra={
                    "correlation_id": correlation_id,
                    "verification_duration": verification_duration,
                    "cache_status": credential_service.get_cache_status(),
                },
            )

            return {
                "success": True,
                "message": "Database setup verified successfully",
                "verification_duration": verification_duration,
                "correlation_id": correlation_id,
            }
        else:
            logger.warning(
                "Database setup verification failed - tables still not found",
                extra={"correlation_id": correlation_id, "cache_status": credential_service.get_cache_status()},
            )

            return {
                "success": False,
                "message": "Database tables still not found - please run the setup SQL",
                "correlation_id": correlation_id,
                "remediation": "Execute the provided SQL in your Supabase SQL editor",
            }

    except DatabaseConfigurationError as e:
        logger.warning(
            f"Database configuration issue during verification: {e}",
            extra={"correlation_id": correlation_id, "error_context": e.to_dict()},
        )

        return {
            "success": False,
            "message": f"Configuration issue: {e}",
            "correlation_id": correlation_id,
            "remediation": e.setup_guide,
        }

    except DatabaseNotInitializedException as e:
        logger.debug(f"Database tables not found during verification: {e}", extra={"correlation_id": correlation_id})
        return {
            "success": False,
            "message": "Database tables still not found - please run the setup SQL",
            "correlation_id": correlation_id,
        }

    except DatabaseConnectionError as e:
        logger.error(
            f"Database verification failed with connection error: {e}",
            extra={"correlation_id": correlation_id, "error_context": e.context},
            exc_info=True,
        )

        return {
            "success": False,
            "message": f"Database verification failed: {e}",
            "error_details": e.context,
            "correlation_id": correlation_id,
            "remediation": e.remediation,
        }

    except Exception as e:
        error_context = {
            "error_type": type(e).__name__,
            "correlation_id": correlation_id,
            "cache_status": credential_service.get_cache_status(),
        }

        logger.error(f"Unexpected error during database verification: {e}", extra=error_context, exc_info=True)

        return {
            "success": False,
            "message": f"Database verification failed unexpectedly: {e}",
            "error_details": error_context,
            "correlation_id": correlation_id,
            "remediation": "Check logs for detailed error information",
        }
