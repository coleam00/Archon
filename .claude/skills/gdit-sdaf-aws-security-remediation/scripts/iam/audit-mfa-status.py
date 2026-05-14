#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
IAM.5/IAM.19 Audit: MFA Status Report
Generates report of IAM users without MFA enabled
"""

import boto3
import argparse
import json
import os
from datetime import datetime
from pathlib import Path

def audit_mfa_status(profile_name, region, output_format='text'):
    """
    Generate MFA status report for all IAM users
    
    SECURITY: Report files are NEVER saved in scripts directory.
    All output goes to project temp/ directory to prevent sensitive data
    from being committed to git or stored in framework directories.
    """
    try:
        session = boto3.Session(profile_name=profile_name)
        iam_client = session.client('iam', region_name=region)
        sts_client = session.client('sts', region_name=region)
        
        # Get account number
        account_id = sts_client.get_caller_identity()['Account']
        
        # Get all users
        users_response = iam_client.list_users()
        users = users_response['Users']
        
        results = {
            'timestamp': datetime.now().isoformat(),
            'account_id': account_id,
            'region': region,
            'total_users': len(users),
            'users_with_mfa': 0,
            'users_without_mfa': 0,
            'users': []
        }
        
        for user in users:
            username = user['UserName']
            
            # Check MFA devices
            mfa_devices = iam_client.list_mfa_devices(UserName=username)
            has_mfa = len(mfa_devices['MFADevices']) > 0
            
            # Check console access
            try:
                iam_client.get_login_profile(UserName=username)
                has_console = True
            except iam_client.exceptions.NoSuchEntityException:
                has_console = False
            
            user_info = {
                'username': username,
                'has_mfa': has_mfa,
                'mfa_count': len(mfa_devices['MFADevices']),
                'has_console_access': has_console,
                'compliant': has_mfa
            }
            
            results['users'].append(user_info)
            
            if has_mfa:
                results['users_with_mfa'] += 1
            else:
                results['users_without_mfa'] += 1
        
        results['compliance_rate'] = (results['users_with_mfa'] / results['total_users'] * 100) if results['total_users'] > 0 else 0
        
        return results
        
    except Exception as e:
        return {
            'status': 'ERROR',
            'message': f'Audit failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='IAM MFA Status Audit (IAM.5/IAM.19)')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--format', choices=['text', 'json', 'csv'], default='text', help='Output format')
    parser.add_argument('--output', help='Output file (default: mfa-status-{account}-{region}-{date}.{ext})')
    
    args = parser.parse_args()
    
    print("🔍 IAM MFA Status Audit")
    print(f"Profile: {args.profile}, Region: {args.region}")
    print("")
    
    results = audit_mfa_status(args.profile, args.region, args.format)
    
    if results.get('status') == 'ERROR':
        print(f"❌ {results['message']}")
        return 1
    
    # Generate default filename if not provided
    if not args.output:
        account_id = results.get('account_id', 'unknown')
        region = results.get('region', 'unknown')
        date_str = datetime.now().strftime('%Y%m%d')
        ext = 'json' if args.format == 'json' else 'csv' if args.format == 'csv' else 'txt'
        filename = f"mfa-status-{account_id}-{region}-{date_str}.{ext}"
        
        # CRITICAL: Always save to project temp/ directory (never in scripts directory)
        # Find project root (look for .netra-framework directory)
        script_dir = Path(__file__).resolve().parent
        project_root = script_dir
        while project_root.parent != project_root:
            if (project_root / '.netra-framework').exists():
                break
            project_root = project_root.parent
        
        # Use project temp folder (outside git, outside scripts directory)
        temp_dir = project_root / 'temp'
        temp_dir.mkdir(exist_ok=True)
        args.output = str(temp_dir / filename)
        
        print(f"📁 Output location: {args.output}")
        print(f"   (Saved to project temp/ directory, not scripts directory)")
    
    # Display results
    if args.format == 'json':
        output = json.dumps(results, indent=2)
    elif args.format == 'csv':
        output = "Username,HasMFA,MFACount,ConsoleAccess,Compliant\n"
        for user in results['users']:
            output += f"{user['username']},{user['has_mfa']},{user['mfa_count']},{user['has_console_access']},{user['compliant']}\n"
    else:  # text
        output = f"📊 MFA Compliance Report\n"
        output += f"{'='*60}\n"
        output += f"Total Users: {results['total_users']}\n"
        output += f"✅ With MFA: {results['users_with_mfa']}\n"
        output += f"❌ Without MFA: {results['users_without_mfa']}\n"
        output += f"Compliance Rate: {results['compliance_rate']:.1f}%\n\n"
        
        if results['users_without_mfa'] > 0:
            output += "❌ Users Without MFA:\n"
            for user in results['users']:
                if not user['has_mfa']:
                    console = "Console" if user['has_console_access'] else "No Console"
                    output += f"  • {user['username']} ({console})\n"
        else:
            output += "✅ All users have MFA enabled!\n"
    
    if args.output:
        with open(args.output, 'w') as f:
            f.write(output)
        print(f"📄 Report saved to: {args.output}")
    else:
        print(output)
    
    return 0 if results['users_without_mfa'] == 0 else 1

if __name__ == '__main__':
    exit(main())
