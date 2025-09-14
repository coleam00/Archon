"""
Website Detection Package

Intelligent website type detection system for automatic crawling mode selection.
Provides advanced analysis capabilities including URL patterns, content analysis,
and machine learning-based classification.
"""

from .website_detector import (
    WebsiteTypeDetector,
    DetectionResult,
    DetectionFeature,
    ConfidenceLevel,
    detect_website_type,
    get_detector
)

__all__ = [
    "WebsiteTypeDetector",
    "DetectionResult", 
    "DetectionFeature",
    "ConfidenceLevel",
    "detect_website_type",
    "get_detector"
]