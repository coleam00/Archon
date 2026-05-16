#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Project Configuration Manager for Gitleaks Compliance
Manages saved GitLab projects and active project selection
"""
import json
import subprocess
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional


def _detect_from_git_remote() -> Optional[Dict]:
    """Auto-detect GitLab project from current git remote and tokens config."""
    try:
        result = subprocess.run(
            ['git', 'remote', 'get-url', 'origin'],
            capture_output=True, text=True, check=True, shell=False
        )
        remote_url = result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None

    # Normalize: strip .git suffix and extract host + path
    remote_url = remote_url.rstrip('/')
    if remote_url.endswith('.git'):
        remote_url = remote_url[:-4]

    # Parse host and path from https:// or git@ URLs
    if remote_url.startswith('https://'):
        parts = remote_url[len('https://'):].split('/', 1)
    elif remote_url.startswith('git@'):
        host_path = remote_url[len('git@'):]
        parts = host_path.replace(':', '/', 1).split('/', 1)
    else:
        return None

    if len(parts) != 2:
        return None
    host, project_path = parts[0], parts[1]

    # Load tokens config to find matching project
    tokens_paths = [
        Path.home() / 'dev' / '.gdit-sdaf-secrets' / 'gitlab-tokens.json',
        Path.home() / '.gdit-sdaf-secrets' / 'gitlab-tokens.json',
    ]
    for tokens_path in tokens_paths:
        if not tokens_path.exists():
            continue
        try:
            with open(tokens_path) as f:
                tokens_config = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        for base_url, cfg in tokens_config.items():
            api_usage = cfg.get('api_usage', {})
            # Check if host matches this GitLab instance
            if host not in base_url:
                continue
            for proj_name, proj_info in api_usage.get('projects', {}).items():
                if proj_info.get('path', '') == project_path:
                    return {
                        'id': str(proj_info['project_id']),
                        'name': proj_name,
                        'gitlab_url': api_usage.get('base_url', base_url),
                        'path': project_path,
                        'local_path': str(Path.cwd()),
                    }
    return None


class ProjectConfig:
    """Manages GitLab project configurations"""
    
    def __init__(self, config_path: str = None):
        if config_path is None:
            config_path = Path(__file__).parent.parent / 'config' / 'config.json'
        self.config_path = Path(config_path)
        self.config = self._load_config()
    
    def _load_config(self) -> Dict:
        """Load configuration from file"""
        if self.config_path.exists():
            try:
                with open(self.config_path) as f:
                    return json.load(f)
            except Exception:
                pass
        
        # Default config
        return {
            'active_project': None,
            'gitlab_url': 'https://ridgeline.emergelabs-gdit.com',
            'projects': []
        }
    
    def _save_config(self):
        """Save configuration to file"""
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.config_path, 'w') as f:
            json.dump(self.config, f, indent=2)
    
    def get_active_project(self) -> Optional[Dict]:
        """Get active project. Falls back to auto-detect from git remote."""
        active_id = self.config.get('active_project')
        if active_id:
            for project in self.config['projects']:
                if project['id'] == active_id:
                    return project

        # Auto-detect from current git remote
        detected = _detect_from_git_remote()
        if detected:
            # Register and activate it
            existing = [p for p in self.config['projects'] if p['id'] == detected['id']]
            if not existing:
                self.add_project(detected['id'], detected['gitlab_url'], detected['name'], detected['local_path'])
            self.set_active_project(detected['id'])
            print(f"📂 Auto-detected project: {detected['name']} (ID: {detected['id']}) from git remote")
            return detected
        return None
    
    def set_active_project(self, project_id: str):
        """Set active project"""
        # Check if project exists
        project_exists = any(p['id'] == project_id for p in self.config['projects'])
        if not project_exists:
            return {'success': False, 'error': f'Project {project_id} not found in saved projects'}
        
        self.config['active_project'] = project_id
        
        # Update last_used timestamp
        for project in self.config['projects']:
            if project['id'] == project_id:
                project['last_used'] = datetime.now().isoformat()
        
        self._save_config()
        return {'success': True, 'project_id': project_id}
    
    def add_project(self, project_id: str, gitlab_url: str = None, name: str = None, local_path: str = None):
        """Add project to saved list"""
        # Check if already exists
        for project in self.config['projects']:
            if project['id'] == project_id:
                return {'success': False, 'error': f'Project {project_id} already exists'}
        
        if gitlab_url is None:
            gitlab_url = self.config['gitlab_url']
        
        if name is None:
            name = f"Project {project_id}"
        
        # Default to project root (look for .git directory)
        if local_path is None:
            script_dir = Path(__file__).resolve().parent
            project_root = script_dir
            while project_root.parent != project_root:
                if (project_root / '.git').exists():
                    local_path = str(project_root)
                    break
                project_root = project_root.parent
            
            # Fallback to current working directory
            if local_path is None:
                local_path = str(Path.cwd())
        
        project = {
            'id': project_id,
            'name': name,
            'gitlab_url': gitlab_url,
            'local_path': local_path,
            'last_used': datetime.now().isoformat()
        }
        
        self.config['projects'].append(project)
        
        # Set as active if no active project
        if not self.config['active_project']:
            self.config['active_project'] = project_id
        
        self._save_config()
        return {'success': True, 'project': project}
    
    def list_projects(self) -> List[Dict]:
        """List all saved projects"""
        return self.config['projects']
    
    def remove_project(self, project_id: str):
        """Remove project from saved list"""
        self.config['projects'] = [p for p in self.config['projects'] if p['id'] != project_id]
        
        # Clear active if it was the removed project
        if self.config['active_project'] == project_id:
            self.config['active_project'] = None
            if self.config['projects']:
                self.config['active_project'] = self.config['projects'][0]['id']
        
        self._save_config()
        return {'success': True}
    
    def update_local_path(self, project_id: str, local_path: str):
        """Update local file path for a project"""
        for project in self.config['projects']:
            if project['id'] == project_id:
                project['local_path'] = local_path
                self._save_config()
                return {'success': True, 'project': project}
        
        return {'success': False, 'error': f'Project {project_id} not found'}
    
    def update_project(self, project_id: str, **updates):
        """Update project attributes"""
        for project in self.config['projects']:
            if project['id'] == project_id:
                for key, value in updates.items():
                    if key in ['name', 'gitlab_url', 'local_path']:
                        project[key] = value
                self._save_config()
                return {'success': True, 'project': project}
        
        return {'success': False, 'error': f'Project {project_id} not found'}


def main():
    """CLI interface for project configuration"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Gitleaks Compliance - Project Configuration')
    parser.add_argument('action', choices=['list', 'add', 'update', 'remove', 'set-active'],
                       help='Action to perform')
    parser.add_argument('--project-id', help='GitLab project ID')
    parser.add_argument('--name', help='Project name')
    parser.add_argument('--gitlab-url', help='GitLab URL (default: https://gitlab.com)')
    parser.add_argument('--local-path', help='Local file path for remediation')
    
    args = parser.parse_args()
    config = ProjectConfig()
    
    if args.action == 'list':
        print("\n🔐 Gitleaks Compliance - Project Configuration\n")
        
        active = config.get_active_project()
        if active:
            print(f"Active Project: {active['name']} (ID: {active['id']})")
        else:
            print("No active project set")
        
        print(f"\nSaved Projects ({len(config.list_projects())}):\n")
        
        projects = config.list_projects()
        if projects:
            for i, project in enumerate(projects, 1):
                active_marker = "✓" if project['id'] == config.config['active_project'] else " "
                print(f"  {i}. [{active_marker}] {project['name']} (ID: {project['id']})")
                print(f"      URL: {project['gitlab_url']}")
                local_path = project.get('local_path', 'Not configured')
                print(f"      Local path: {local_path}")
                print(f"      Last used: {project.get('last_used', 'Never')}\n")
        else:
            print("  No saved projects\n")
    
    elif args.action == 'add':
        if not args.project_id:
            print("❌ Error: --project-id required for add action")
            return 1
        
        result = config.add_project(
            args.project_id,
            args.gitlab_url,
            args.name,
            args.local_path
        )
        
        if result['success']:
            print(f"✅ Added project: {result['project']['name']}")
        else:
            print(f"❌ Error: {result['error']}")
            return 1
    
    elif args.action == 'set-active':
        if not args.project_id:
            print("❌ Error: --project-id required for set-active action")
            return 1
        
        result = config.set_active_project(args.project_id)
        if result['success']:
            print(f"✅ Set active project: {args.project_id}")
        else:
            print(f"❌ Error: {result['error']}")
            return 1
    
    elif args.action == 'update':
        if not args.project_id:
            print("❌ Error: --project-id required for update action")
            return 1
        
        updates = {}
        if args.name:
            updates['name'] = args.name
        if args.gitlab_url:
            updates['gitlab_url'] = args.gitlab_url
        if args.local_path:
            updates['local_path'] = args.local_path
        
        if not updates:
            print("❌ Error: No updates specified (use --name, --gitlab-url, or --local-path)")
            return 1
        
        result = config.update_project(args.project_id, **updates)
        if result['success']:
            print(f"✅ Updated project: {args.project_id}")
        else:
            print(f"❌ Error: {result['error']}")
            return 1
    
    elif args.action == 'remove':
        if not args.project_id:
            print("❌ Error: --project-id required for remove action")
            return 1
        
        config.remove_project(args.project_id)
        print(f"✅ Removed project: {args.project_id}")
    
    return 0


if __name__ == "__main__":
    main()
