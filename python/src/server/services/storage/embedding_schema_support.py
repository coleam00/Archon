"""Embedding schema compatibility helpers.

Some deployments still rely on the original single-column `embedding` layout while
newer migrations expose dedicated columns per vector dimension.  These helpers
allow storage services to detect missing dimension columns at runtime and fall
back to the legacy column without crashing uploads.
"""

from __future__ import annotations

from collections.abc import Iterable, MutableMapping

from ...config.logfire_config import search_logger

# Column names used in the upgraded schema
DIMENSION_COLUMNS: tuple[str, ...] = (
    "embedding_384",
    "embedding_768",
    "embedding_1024",
    "embedding_1536",
    "embedding_3072",
)
LEGACY_COLUMN = "embedding"

# Cache whether the database supports the upgraded schema.  "None" means we
# haven't determined support yet, ``True`` means the per-dimension columns exist,
# and ``False`` means we must fall back to the legacy column.
_multi_dim_schema_supported: bool | None = None

# Mapping of common embedding vector sizes to their dedicated columns.
_DIMENSION_TO_COLUMN = {
    384: "embedding_384",
    768: "embedding_768",
    1024: "embedding_1024",
    1536: "embedding_1536",
    3072: "embedding_3072",
}


def determine_embedding_column(dimension: int) -> str:
    """Return the appropriate column name for a given embedding dimension."""

    if _multi_dim_schema_supported is False:
        return LEGACY_COLUMN

    # Default to the OpenAI dimension column when the exact size is unknown.
    return _DIMENSION_TO_COLUMN.get(dimension, _DIMENSION_TO_COLUMN.get(1536, LEGACY_COLUMN))


def note_multi_dim_success() -> None:
    """Record that the upgraded schema appears to be available."""

    global _multi_dim_schema_supported
    if _multi_dim_schema_supported is None:
        _multi_dim_schema_supported = True


def should_retry_with_legacy_column(error: Exception, records: Iterable[MutableMapping[str, object]]) -> bool:
    """Inspect an error and decide whether to retry using the legacy column.

    When the PostgREST API returns a message like
    "Could not find the 'embedding_1536' column", we switch the in-memory
    records to use the legacy ``embedding`` column and ask the caller to retry.
    """

    message = str(error)
    if not any(column in message for column in DIMENSION_COLUMNS):
        return False

    _mark_schema_as_legacy()
    converted = _convert_records_to_legacy(records)

    if converted:
        search_logger.warning(
            "Multi-dimensional embedding columns unavailable. Falling back to legacy 'embedding' column."
        )
        return True

    return False


def _mark_schema_as_legacy() -> None:
    global _multi_dim_schema_supported
    _multi_dim_schema_supported = False


def _convert_records_to_legacy(records: Iterable[MutableMapping[str, object]]) -> bool:
    """Move any per-dimension embeddings to the legacy column."""

    converted = False
    for record in records:
        for column in DIMENSION_COLUMNS:
            if column in record:
                # Do not clobber an existing legacy value if the caller already set it.
                record.setdefault(LEGACY_COLUMN, record.pop(column))
                converted = True
    return converted


def legacy_column_in_use() -> bool:
    """Expose whether we are currently using the legacy embedding column."""

    return _multi_dim_schema_supported is False

