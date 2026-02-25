"""
Version configuration for Archon.
"""

import os

# Current version of Archon
# Update this with each release
ARCHON_VERSION = "0.6.1"

# Repository information for GitHub API.
# Override by setting GITHUB_REPO="owner/repo" in the environment.
_repo_env = os.getenv("GITHUB_REPO", "")
if _repo_env and "/" in _repo_env:
    GITHUB_REPO_OWNER, GITHUB_REPO_NAME = _repo_env.split("/", 1)
else:
    GITHUB_REPO_OWNER = "coleam00"
    GITHUB_REPO_NAME = "Archon"
