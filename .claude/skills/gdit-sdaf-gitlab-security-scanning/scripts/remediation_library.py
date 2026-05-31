#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Remediation Library - Manages reusable remediation scripts
"""
import sys
import subprocess
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional

sys.path.insert(0, str(Path(__file__).parent))

def validate_file_path(path, base_dir=None):
    return Path(path)

def sanitize_error(msg):
    return str(msg)


class RemediationLibrary:
    """Manages reusable remediation scripts"""
    
    def __init__(self, library_path: str = None):
        if library_path is None:
            library_path = Path(__file__).parent / "remediation-library" / "scripts"
        self.library_path = Path(library_path)
        self.library_path.mkdir(parents=True, exist_ok=True)
        
        # Finding type to script mapping
        self.script_patterns = {
            'aws_access_key': 'aws_access_key_remediation.py',
            'github_token': 'github_token_remediation.py',
            'generic_api_key': 'generic_api_key_remediation.py',
            'private_key': 'private_key_remediation.py'
        }
    
    def get_script(self, finding_type: str) -> Optional[Path]:
        """Get existing script or None"""
        # Normalize finding type
        finding_type = finding_type.lower().replace(' ', '_').replace('-', '_')
        
        # Check known patterns
        if finding_type in self.script_patterns:
            script_name = self.script_patterns[finding_type]
        else:
            script_name = f"{finding_type}_remediation.py"
        
        script_path = self.library_path / script_name
        return script_path if script_path.exists() else None
    
    def create_script(self, finding_type: str, pattern: str) -> Path:
        """Generate new parameterized script"""
        finding_type = finding_type.lower().replace(' ', '_').replace('-', '_')
        script_name = f"{finding_type}_remediation.py"
        script_path = self.library_path / script_name
        
        # Load template
        template_path = Path(__file__).parent / "templates" / "remediation_script_template.py"
        if template_path.exists():
            with open(template_path, 'r') as f:
                template = f.read()
        else:
            # Use embedded template
            template = self._get_embedded_template()
        
        # Replace placeholders
        script_content = template.replace('{FINDING_TYPE}', finding_type)
        script_content = script_content.replace('{TIMESTAMP}', datetime.now().isoformat())
        script_content = script_content.replace('{PATTERN}', pattern)
        
        # Write script
        with open(script_path, 'w') as f:
            f.write(script_content)
        
        # Make executable
        script_path.chmod(0o755)
        
        return script_path
    
    def list_scripts(self) -> List[Dict]:
        """List all available scripts"""
        scripts = []
        for script_file in self.library_path.glob('*_remediation.py'):
            scripts.append({
                'name': script_file.name,
                'path': str(script_file),
                'type': script_file.stem.replace('_remediation', '')
            })
        return scripts
    
    def execute_script(self, script_path: Path, file_path: str, line_number: int, 
                      pattern: str, dry_run: bool = False) -> Dict:
        """Execute remediation script with parameters"""
        try:
            cmd = [
                'python3', str(script_path),
                '--file', file_path,
                '--line', str(line_number),
                '--pattern', pattern
            ]
            
            if dry_run:
                cmd.append('--dry-run')
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            
            return {
                'success': result.returncode == 0,
                'stdout': result.stdout,
                'stderr': result.stderr
            }
            
        except subprocess.TimeoutExpired:
            return {'success': False, 'error': 'Script timeout'}
        except Exception as e:
            return {'success': False, 'error': sanitize_error(str(e))}
    
    def _get_embedded_template(self) -> str:
        """Embedded template if file not found"""
        return '''#!/usr/bin/env python3
"""
Remediation script for {FINDING_TYPE}
Auto-generated: {TIMESTAMP}
"""
import sys
import re
import argparse
from pathlib import Path

def remediate(file_path: str, line_number: int, pattern: str, replacement: str = "", dry_run: bool = False):
    try:
        file_path = Path(file_path)
        if not file_path.exists():
            return {'success': False, 'message': f'File not found: {file_path}'}
        
        with open(file_path, 'r') as f:
            lines = f.readlines()
        
        if line_number < 1 or line_number > len(lines):
            return {'success': False, 'message': f'Invalid line number: {line_number}'}
        
        target_line = lines[line_number - 1]
        
        if re.search(pattern, target_line):
            new_line = re.sub(pattern, replacement, target_line)
            
            if dry_run:
                return {
                    'success': True,
                    'message': 'Dry run - no changes applied',
                    'changes': {
                        'file': str(file_path),
                        'line': line_number,
                        'old': target_line.strip(),
                        'new': new_line.strip()
                    }
                }
            
            lines[line_number - 1] = new_line
            
            with open(file_path, 'w') as f:
                f.writelines(lines)
            
            return {
                'success': True,
                'message': 'Remediation applied',
                'changes': {
                    'file': str(file_path),
                    'line': line_number,
                    'old': target_line.strip(),
                    'new': new_line.strip()
                }
            }
        else:
            return {'success': False, 'message': 'Pattern not found'}
    
    except Exception as e:
        return {'success': False, 'message': f'Error: {str(e)}'}

def main():
    parser = argparse.ArgumentParser(description='Remediate {FINDING_TYPE}')
    parser.add_argument('--file', required=True, help='File path')
    parser.add_argument('--line', type=int, required=True, help='Line number')
    parser.add_argument('--pattern', required=True, help='Pattern to match')
    parser.add_argument('--replacement', default='', help='Replacement text')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    
    args = parser.parse_args()
    result = remediate(args.file, args.line, args.pattern, args.replacement, args.dry_run)
    
    print(f"Status: {'SUCCESS' if result['success'] else 'FAILED'}")
    print(f"Message: {result['message']}")
    if 'changes' in result:
        print(f"\\nChanges:")
        print(f"  File: {result['changes']['file']}")
        print(f"  Line: {result['changes']['line']}")
        print(f"  Old:  {result['changes']['old']}")
        print(f"  New:  {result['changes']['new']}")
    
    sys.exit(0 if result['success'] else 1)

if __name__ == "__main__":
    main()
'''


def main():
    """CLI interface for testing"""
    library = RemediationLibrary()
    
    print("📚 Remediation Script Library\n")
    scripts = library.list_scripts()
    
    if scripts:
        print(f"Available scripts: {len(scripts)}\n")
        for script in scripts:
            print(f"  • {script['name']}")
            print(f"    Type: {script['type']}\n")
    else:
        print("No scripts in library yet.")


if __name__ == "__main__":
    main()
