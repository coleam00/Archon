"""
Unit tests for vector utilities.
"""

import math
import pytest

from src.server.infrastructure.memory.vector_utils import (
    cosine_similarity,
    euclidean_distance,
    normalize_vector,
)


class TestCosineSimilarity:
    """Tests for cosine similarity calculation."""

    def test_identical_vectors(self):
        """Identical vectors should have similarity 1.0."""
        vec = [1.0, 2.0, 3.0]
        similarity = cosine_similarity(vec, vec)
        assert similarity == pytest.approx(1.0)

    def test_opposite_vectors(self):
        """Opposite vectors should have similarity close to 0."""
        vec1 = [1.0, 0.0]
        vec2 = [-1.0, 0.0]
        similarity = cosine_similarity(vec1, vec2)
        # Cosine similarity clips to [0, 1] in our implementation
        assert similarity == pytest.approx(0.0)

    def test_orthogonal_vectors(self):
        """Orthogonal vectors should have similarity 0."""
        vec1 = [1.0, 0.0]
        vec2 = [0.0, 1.0]
        similarity = cosine_similarity(vec1, vec2)
        assert similarity == pytest.approx(0.0)

    def test_similar_vectors(self):
        """Similar vectors should have high similarity."""
        vec1 = [1.0, 2.0, 3.0]
        vec2 = [1.1, 2.1, 3.1]
        similarity = cosine_similarity(vec1, vec2)
        assert similarity > 0.99

    def test_different_lengths_raises(self):
        """Vectors of different lengths should raise ValueError."""
        vec1 = [1.0, 2.0]
        vec2 = [1.0, 2.0, 3.0]
        with pytest.raises(ValueError, match="same length"):
            cosine_similarity(vec1, vec2)

    def test_empty_vectors_raises(self):
        """Empty vectors should raise ValueError."""
        with pytest.raises(ValueError, match="empty"):
            cosine_similarity([], [])

    def test_zero_vector(self):
        """Zero vector should return 0 similarity."""
        vec1 = [0.0, 0.0, 0.0]
        vec2 = [1.0, 2.0, 3.0]
        similarity = cosine_similarity(vec1, vec2)
        assert similarity == 0.0

    def test_normalized_vectors(self):
        """Normalized vectors should work correctly."""
        vec1 = normalize_vector([1.0, 1.0])
        vec2 = normalize_vector([1.0, 0.0])
        similarity = cosine_similarity(vec1, vec2)
        # 45 degree angle -> cos(45) = sqrt(2)/2 ≈ 0.707
        assert similarity == pytest.approx(math.sqrt(2) / 2, abs=0.001)

    def test_high_dimensional_vectors(self):
        """Should work with high-dimensional vectors."""
        vec1 = [0.1] * 1536
        vec2 = [0.1] * 1536
        similarity = cosine_similarity(vec1, vec2)
        assert similarity == pytest.approx(1.0)

    def test_result_in_valid_range(self):
        """Result should always be in [0, 1] range."""
        import random
        for _ in range(100):
            vec1 = [random.uniform(-1, 1) for _ in range(10)]
            vec2 = [random.uniform(-1, 1) for _ in range(10)]
            similarity = cosine_similarity(vec1, vec2)
            assert 0.0 <= similarity <= 1.0


class TestEuclideanDistance:
    """Tests for Euclidean distance calculation."""

    def test_identical_vectors(self):
        """Identical vectors should have distance 0."""
        vec = [1.0, 2.0, 3.0]
        distance = euclidean_distance(vec, vec)
        assert distance == pytest.approx(0.0)

    def test_known_distance(self):
        """Should calculate correct distance for known case."""
        vec1 = [0.0, 0.0]
        vec2 = [3.0, 4.0]
        distance = euclidean_distance(vec1, vec2)
        assert distance == pytest.approx(5.0)  # 3-4-5 triangle

    def test_different_lengths_raises(self):
        """Vectors of different lengths should raise ValueError."""
        vec1 = [1.0, 2.0]
        vec2 = [1.0, 2.0, 3.0]
        with pytest.raises(ValueError, match="same length"):
            euclidean_distance(vec1, vec2)

    def test_unit_vectors(self):
        """Distance between unit vectors on axes."""
        vec1 = [1.0, 0.0]
        vec2 = [0.0, 1.0]
        distance = euclidean_distance(vec1, vec2)
        assert distance == pytest.approx(math.sqrt(2))


class TestNormalizeVector:
    """Tests for vector normalization."""

    def test_normalize_unit_vector(self):
        """Unit vector should remain unchanged."""
        vec = [1.0, 0.0, 0.0]
        normalized = normalize_vector(vec)
        assert normalized == pytest.approx([1.0, 0.0, 0.0])

    def test_normalize_non_unit_vector(self):
        """Non-unit vector should be normalized to unit length."""
        vec = [3.0, 4.0]
        normalized = normalize_vector(vec)
        # Magnitude should be 1
        magnitude = math.sqrt(sum(x * x for x in normalized))
        assert magnitude == pytest.approx(1.0)
        # Direction should be preserved
        assert normalized[0] == pytest.approx(0.6)
        assert normalized[1] == pytest.approx(0.8)

    def test_normalize_zero_vector(self):
        """Zero vector should return zero vector."""
        vec = [0.0, 0.0, 0.0]
        normalized = normalize_vector(vec)
        assert normalized == [0.0, 0.0, 0.0]

    def test_normalize_preserves_direction(self):
        """Normalization should preserve direction."""
        vec = [2.0, 2.0]
        normalized = normalize_vector(vec)
        # Both components should be equal (45 degree angle)
        assert normalized[0] == pytest.approx(normalized[1])
        # Both should be sqrt(2)/2
        assert normalized[0] == pytest.approx(math.sqrt(2) / 2)
