"""
API routes for the Situation Agent.

POST /api/situation/analyze — collect state, call Claude, return structured brief.
"""

from typing import Any

from fastapi import APIRouter, HTTPException

from ..config.logfire_config import get_logger
from ..services.situation_service import SituationService

logger = get_logger(__name__)
router = APIRouter(prefix="/api/situation", tags=["Situation Agent"])


@router.post("/analyze")
async def analyze_situation() -> dict[str, Any]:
    """
    Collect current Archon system state, generate an AI situation brief,
    persist it to shared context, and return the structured result.
    """
    try:
        service = SituationService()
        state = await service.collect_state()
        brief = await service.generate_brief(state)
        await service.save_and_audit(brief)
        return brief
    except Exception as e:
        logger.error(f"Situation analysis failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Situation analysis failed: {str(e)}")
