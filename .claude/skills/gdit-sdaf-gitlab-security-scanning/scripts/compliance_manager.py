#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["pyyaml"]
# ///
"""
Project Compliance Manager

Manages specs/project-compliance.md file integration for Gitleaks standard.
Implements FR-GITLEAKS-006: Project Compliance Integration.
"""

import yaml
from pathlib import Path
from typing import Dict, Optional


class ComplianceManager:
    """Manages project compliance standards file"""
    
    GITLEAKS_STANDARD = {
        'Gitleaks': {
            'description': 'Secret detection and prevention',
            'requirements': [
                'No secrets, tokens, or credentials in code',
                'Automated Gitleaks scanning in CI/CD',
                'Mandatory remediation of all findings',
                'Token rotation for exposed credentials'
            ],
            'enforcement': [
                'Pre-commit hooks for secret detection',
                'GitLab security scanning enabled',
                'Findings tracked and remediated systematically'
            ]
        }
    }
    
    def __init__(self, project_root: Optional[Path] = None):
        """Initialize compliance manager
        
        Args:
            project_root: Project root directory (auto-detected if None)
        """
        if project_root is None:
            project_root = self._find_project_root()
        self.project_root = Path(project_root)
        self.compliance_file = self.project_root / 'specs' / 'project-compliance.md'
    
    def _find_project_root(self) -> Path:
        """Find project root by looking for .git directory"""
        current = Path(__file__).resolve()
        while current.parent != current:
            if (current / '.git').exists():
                return current
            current = current.parent
        return Path.cwd()
    
    def check_and_update(self) -> Dict[str, str]:
        """Check compliance file and add Gitleaks if needed
        
        Returns:
            Dict with status and message
        """
        if not self.compliance_file.exists():
            return self._create_compliance_file()
        else:
            return self._update_compliance_file()
    
    def _create_compliance_file(self) -> Dict[str, str]:
        """Create new compliance file with Gitleaks standard"""
        # Ensure specs directory exists
        self.compliance_file.parent.mkdir(parents=True, exist_ok=True)
        
        # Create file with Gitleaks standard
        content = self._generate_compliance_content([])
        
        with open(self.compliance_file, 'w') as f:
            f.write(content)
        
        return {
            'status': 'CREATED',
            'message': f'Created {self.compliance_file} with Gitleaks standard'
        }
    
    def _update_compliance_file(self) -> Dict[str, str]:
        """Update existing compliance file to add Gitleaks if missing"""
        with open(self.compliance_file, 'r') as f:
            content = f.read()
        
        # Check if Gitleaks already present
        if 'Gitleaks:' in content or 'gitleaks' in content.lower():
            return {
                'status': 'EXISTS',
                'message': 'Gitleaks standard already present in compliance file'
            }
        
        # Parse existing standards
        existing_standards = self._parse_existing_standards(content)
        
        # Add Gitleaks to standards
        existing_standards.append('Gitleaks')
        
        # Generate updated content
        updated_content = self._generate_compliance_content(existing_standards, content)
        
        with open(self.compliance_file, 'w') as f:
            f.write(updated_content)
        
        return {
            'status': 'UPDATED',
            'message': f'Added Gitleaks standard to {self.compliance_file}'
        }
    
    def _parse_existing_standards(self, content: str) -> list:
        """Parse existing standards from compliance file"""
        standards = []
        
        # Look for required_standards list in YAML front matter or content
        if 'required_standards:' in content:
            lines = content.split('\n')
            in_standards = False
            for line in lines:
                if 'required_standards:' in line:
                    in_standards = True
                    continue
                if in_standards:
                    if line.strip().startswith('-'):
                        standard = line.strip().lstrip('- ').strip('"\'')
                        if standard and standard != 'Gitleaks':
                            standards.append(standard)
                    elif line.strip() and not line.startswith(' '):
                        break
        
        return standards
    
    def _generate_compliance_content(self, existing_standards: list, original_content: str = '') -> str:
        """Generate compliance file content with Gitleaks standard
        
        Args:
            existing_standards: List of existing standard names
            original_content: Original file content to preserve
        """
        # Add Gitleaks to standards list
        all_standards = existing_standards + ['Gitleaks']
        
        # Generate standards list
        standards_yaml = '\n'.join([f'  - "{std}"' for std in all_standards])
        
        # Generate Gitleaks standard YAML
        gitleaks_yaml = yaml.dump(self.GITLEAKS_STANDARD, default_flow_style=False, sort_keys=False)
        
        # If original content exists, try to preserve structure
        if original_content and 'required_standards:' in original_content:
            # Update existing file
            lines = original_content.split('\n')
            new_lines = []
            in_standards = False
            standards_updated = False
            
            for line in lines:
                if 'required_standards:' in line:
                    new_lines.append(line)
                    in_standards = True
                    standards_updated = False
                elif in_standards and not standards_updated:
                    if line.strip().startswith('-') or not line.strip():
                        continue
                    else:
                        # End of standards list, insert updated list
                        new_lines.append(standards_yaml)
                        new_lines.append('')
                        new_lines.append(line)
                        in_standards = False
                        standards_updated = True
                else:
                    new_lines.append(line)
            
            # Append Gitleaks standard definition
            content = '\n'.join(new_lines)
            if '## Compliance Standards' not in content:
                content += '\n\n## Compliance Standards\n\n'
            content += f'\n{gitleaks_yaml}'
            
            return content
        else:
            # Create new file
            return f"""# Project Compliance Standards

## Required Standards

required_standards:
{standards_yaml}

## Compliance Standards

{gitleaks_yaml}

## Compliance Notes

This file defines the compliance standards required for this project. Each standard includes:
- Description of the standard
- Specific requirements that must be met
- Enforcement mechanisms

Standards are automatically enforced during development and deployment workflows.
"""
