#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
GitLab Token Manager

Uses shared token storage.
Tokens stored in ../.gdit-sdaf-secrets/gitlab-tokens.json
"""

import os
import json
from pathlib import Path
from typing import Optional, Dict


class GitLabTokenManager:
    """
    Manages GitLab authentication tokens
    
    Token file: ../.gdit-sdaf-secrets/gitlab-tokens.json
    """
    
    def __init__(self, project_root: Optional[Path] = None):
        """
        Initialize token manager
        
        Args:
            project_root: Project root directory (default: auto-detect)
        """
        if project_root is None:
            # Auto-detect project root by looking for .git directory
            current = Path.cwd()
            while current != current.parent:
                if (current / '.git').exists():
                    project_root = current
                    break
                current = current.parent
            
            # Fallback to current directory if not found
            if project_root is None:
                project_root = Path.cwd()
        
        # Store tokens one level above project root (shared location)
        self.secrets_dir = project_root.parent / '.gdit-sdaf-secrets'
        self.secrets_dir.mkdir(parents=True, exist_ok=True)
        self.token_file = self.secrets_dir / 'gitlab-tokens.json'
        
        # Set restrictive permissions
        try:
            # nosemgrep
            os.chmod(self.secrets_dir, 0o700)  # Owner-only access for secrets directory
            if self.token_file.exists():
                os.chmod(self.token_file, 0o600)
        except Exception:
            pass  # May fail on Windows
    
    def save_token(self, gitlab_url: str, token: str, description: str = None) -> Dict:
        """
        Save GitLab token
        
        Args:
            gitlab_url: GitLab instance URL
            token: Personal access token
            description: Optional token description
            
        Returns:
            dict: Success status and message
        """
        # Load existing tokens
        tokens = {}
        if self.token_file.exists():
            try:
                with open(self.token_file, 'r') as f:
                    tokens = json.load(f)
            except Exception:
                pass
        
        # Normalize URL
        gitlab_url = gitlab_url.rstrip('/')
        
        # Save token
        tokens[gitlab_url] = {
            'token': token,
            'description': description or 'Extension Library Access'
        }
        
        # Write to file
        with open(self.token_file, 'w') as f:
            json.dump(tokens, f, indent=2)
        
        # Set restrictive permissions
        try:
            os.chmod(self.token_file, 0o600)
        except Exception:
            pass
        
        return {
            'success': True,
            'message': f'Token saved for {gitlab_url}',
            'file': str(self.token_file)
        }
    
    def get_token(self, gitlab_url: str) -> Optional[str]:
        """
        Get GitLab token for URL
        
        Args:
            gitlab_url: GitLab instance URL
            
        Returns:
            str: Token if found, None otherwise
        """
        if not self.token_file.exists():
            return None
        
        try:
            with open(self.token_file, 'r') as f:
                tokens = json.load(f)
            
            # Normalize URL
            gitlab_url = gitlab_url.rstrip('/')
            
            if gitlab_url in tokens:
                return tokens[gitlab_url]['token']
            
            return None
        except Exception:
            return None
    
    def list_tokens(self) -> Dict:
        """
        List all saved tokens (without revealing token values)
        
        Returns:
            dict: GitLab URLs and descriptions
        """
        if not self.token_file.exists():
            return {}
        
        try:
            with open(self.token_file, 'r') as f:
                tokens = json.load(f)
            
            # Return URLs and descriptions only (not tokens)
            return {
                url: data.get('description', 'No description')
                for url, data in tokens.items()
            }
        except Exception:
            return {}
    
    def delete_token(self, gitlab_url: str) -> Dict:
        """
        Delete token for GitLab URL
        
        Args:
            gitlab_url: GitLab instance URL
            
        Returns:
            dict: Success status and message
        """
        if not self.token_file.exists():
            return {'success': False, 'message': 'No tokens found'}
        
        try:
            with open(self.token_file, 'r') as f:
                tokens = json.load(f)
            
            # Normalize URL
            gitlab_url = gitlab_url.rstrip('/')
            
            if gitlab_url in tokens:
                del tokens[gitlab_url]
                
                # Write updated tokens
                with open(self.token_file, 'w') as f:
                    json.dump(tokens, f, indent=2)
                
                return {
                    'success': True,
                    'message': f'Token deleted for {gitlab_url}'
                }
            else:
                return {
                    'success': False,
                    'message': f'No token found for {gitlab_url}'
                }
        except Exception as e:
            return {
                'success': False,
                'message': f'Error deleting token: {str(e)}'
            }


def main():
    """CLI interface for token management"""
    import sys
    
    manager = GitLabTokenManager()
    
    print("\n🔐 GitLab Token Manager (Shared Storage)")
    print(f"📁 Token file: {manager.token_file}\n")
    
    if len(sys.argv) > 1:
        command = sys.argv[1]
        
        if command == 'list':
            tokens = manager.list_tokens()
            if tokens:
                print("Saved tokens:")
                for url, desc in tokens.items():
                    print(f"  • {url}")
                    print(f"    {desc}\n")
            else:
                print("No tokens saved")
        
        elif command == 'delete' and len(sys.argv) > 2:
            url = sys.argv[2]
            result = manager.delete_token(url)
            print(result['message'])
        
        else:
            print("Usage:")
            print("  python gitlab_token_manager.py list")
            print("  python gitlab_token_manager.py delete <gitlab-url>")
    else:
        # Interactive mode
        print("Enter GitLab URL:")
        gitlab_url = input("> ").strip()
        
        print("\nEnter Personal Access Token:")
        token = input("> ").strip()
        
        print("\nEnter description (optional):")
        description = input("> ").strip() or None
        
        result = manager.save_token(gitlab_url, token, description)
        print(f"\n✅ {result['message']}")
        print(f"📁 Saved to: {result['file']}")


if __name__ == "__main__":
    main()
