"""
Vector Utilities for InMemory Repository.

Provides pure Python implementations of vector operations
for simulating vector search in tests.
"""

import math
from typing import Sequence


def cosine_similarity(vec_a: Sequence[float], vec_b: Sequence[float]) -> float:
    """
    Calculate cosine similarity between two vectors.

    Args:
        vec_a: First vector
        vec_b: Second vector

    Returns:
        Cosine similarity score between 0 and 1

    Raises:
        ValueError: If vectors have different lengths or are empty
    """
    if len(vec_a) != len(vec_b):
        raise ValueError(
            f"Vectors must have same length: {len(vec_a)} != {len(vec_b)}"
        )

    if len(vec_a) == 0:
        raise ValueError("Vectors cannot be empty")

    # Calculate dot product and magnitudes
    dot_product = 0.0
    magnitude_a = 0.0
    magnitude_b = 0.0

    for a, b in zip(vec_a, vec_b):
        dot_product += a * b
        magnitude_a += a * a
        magnitude_b += b * b

    magnitude_a = math.sqrt(magnitude_a)
    magnitude_b = math.sqrt(magnitude_b)

    # Handle zero vectors
    if magnitude_a == 0 or magnitude_b == 0:
        return 0.0

    similarity = dot_product / (magnitude_a * magnitude_b)

    # Clip to valid range (floating point errors can cause slight overflow)
    return max(0.0, min(1.0, similarity))


def euclidean_distance(vec_a: Sequence[float], vec_b: Sequence[float]) -> float:
    """
    Calculate Euclidean distance between two vectors.

    Args:
        vec_a: First vector
        vec_b: Second vector

    Returns:
        Euclidean distance (lower = more similar)

    Raises:
        ValueError: If vectors have different lengths
    """
    if len(vec_a) != len(vec_b):
        raise ValueError(
            f"Vectors must have same length: {len(vec_a)} != {len(vec_b)}"
        )

    sum_squared_diff = sum((a - b) ** 2 for a, b in zip(vec_a, vec_b))
    return math.sqrt(sum_squared_diff)


def normalize_vector(vec: Sequence[float]) -> list[float]:
    """
    Normalize a vector to unit length.

    Args:
        vec: Input vector

    Returns:
        Normalized vector with magnitude 1.0
    """
    magnitude = math.sqrt(sum(v * v for v in vec))

    if magnitude == 0:
        return list(vec)

    return [v / magnitude for v in vec]
