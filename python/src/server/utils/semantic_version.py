"""
Semantic version parsing and comparison utilities.
"""

import re


def parse_version(version_string: str) -> tuple[int, int, int, str | None]:
    """
    Parse a semantic version string into major, minor, patch, and optional prerelease.

    Supports formats like:
    - "1.0.0"
    - "v1.0.0"
    - "1.0.0-beta"
    - "v1.0.0-rc.1"

    Args:
        version_string: Version string to parse

    Returns:
        Tuple of (major, minor, patch, prerelease)
    """
    # Remove 'v' prefix if present
    version = version_string.strip()
    if version.lower().startswith('v'):
        version = version[1:]

    # Parse version with optional prerelease
    pattern = r'^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$'
    match = re.match(pattern, version)

    if not match:
        # Try to handle incomplete versions like "1.0"
        simple_pattern = r'^(\d+)(?:\.(\d+))?(?:\.(\d+))?$'
        simple_match = re.match(simple_pattern, version)
        if simple_match:
            major = int(simple_match.group(1))
            minor = int(simple_match.group(2) or 0)
            patch = int(simple_match.group(3) or 0)
            return (major, minor, patch, None)
        raise ValueError(f"Invalid version string: {version_string}")

    major = int(match.group(1))
    minor = int(match.group(2))
    patch = int(match.group(3))
    prerelease = match.group(4)

    return (major, minor, patch, prerelease)


def compare_versions(version1: str, version2: str) -> int:
    """
    Compare two semantic version strings.

    Args:
        version1: First version string
        version2: Second version string

    Returns:
        -1 if version1 < version2
         0 if version1 == version2
         1 if version1 > version2
    """
    v1 = parse_version(version1)
    v2 = parse_version(version2)

    # Compare major, minor, patch
    for i in range(3):
        if v1[i] < v2[i]:
            return -1
        elif v1[i] > v2[i]:
            return 1

    # If main versions are equal, check prerelease
    # No prerelease is considered newer than any prerelease
    if v1[3] is None and v2[3] is None:
        return 0
    elif v1[3] is None:
        return 1  # v1 is release, v2 is prerelease
    elif v2[3] is None:
        return -1  # v1 is prerelease, v2 is release
    else:
        # Both have prereleases, compare lexicographically
        if v1[3] < v2[3]:
            return -1
        elif v1[3] > v2[3]:
            return 1
        return 0


def is_newer_version(current: str, latest: str) -> bool:
    """
    Check if latest version is newer than current version.

    Args:
        current: Current version string
        latest: Latest version string to compare

    Returns:
        True if latest > current, False otherwise
    """
    try:
        return compare_versions(latest, current) > 0
    except ValueError:
        # If we can't parse versions, assume no update
        return False
