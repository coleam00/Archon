#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
Bulk IAM Policy Remediation
Remediates SEC-GENERAL-102, SEC-GENERAL-095, SEC-GENERAL-103
"""

import boto3
import argparse
import sys
import os
from datetime import datetime

# Add current directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import individual remediation functions
try:
    from configure_password_policy import remediate_password_policy
    from create_support_role import remediate_support_role
except ImportError:
    # Fallback: execute scripts directly
    import subprocess
    remediate_password_policy = None
    remediate_support_role = None

def bulk_remediate_iam(profile_name, region, dry_run=False):
    """Execute bulk remediation for IAM policy findings"""
    
    print("=" * 80)
    print("🔧 BULK IAM POLICY REMEDIATION")
    print("=" * 80)
    print(f"Profile: {profile_name}")
    print(f"Region: {region}")
    print(f"Mode: {'DRY RUN' if dry_run else 'LIVE EXECUTION'}")
    print("=" * 80)
    print("")
    
    results = {
        'timestamp': datetime.now().isoformat(),
        'profile': profile_name,
        'region': region,
        'dry_run': dry_run,
        'remediations': []
    }
    
    # Finding ARNs for Security Hub updates
    findings = {
        'password_policy': [
            'arn:aws:securityhub:us-east-1:562239682396:security-control/IAM.10/finding/d6497cba-662b-4c3d-a92d-abc3f304fd8d',  # SEC-GENERAL-102
            'arn:aws:securityhub:us-east-1:562239682396:security-control/IAM.16/finding/ef4c5d12-22ce-4710-a756-df2da56fba40'   # SEC-GENERAL-095
        ],
        'support_role': 'arn:aws:securityhub:us-east-1:562239682396:security-control/IAM.18/finding/bfd339bc-0c2c-41f7-8134-a6dd5fc72d54'  # SEC-GENERAL-103
    }
    
    # 1. Remediate Password Policy (IAM.10, IAM.16)
    print("📋 Step 1: IAM Password Policy Remediation")
    print("-" * 80)
    password_result = remediate_password_policy(
        profile_name=profile_name,
        region=region,
        dry_run=dry_run,
        finding_arns=findings['password_policy']
    )
    results['remediations'].append({
        'control': 'IAM.10/IAM.16',
        'findings': ['SEC-GENERAL-102', 'SEC-GENERAL-095'],
        'result': password_result
    })
    
    status_icon = '✅' if password_result['status'] in ['COMPLIANT', 'REMEDIATED'] else '❌'
    print(f"{status_icon} {password_result['status']}: {password_result['message']}")
    print("")
    
    # 2. Remediate AWS Support Role (IAM.18)
    print("📋 Step 2: AWS Support Role Remediation")
    print("-" * 80)
    support_result = remediate_support_role(
        role_name='AWSSupportRole',
        profile_name=profile_name,
        region=region,
        dry_run=dry_run,
        finding_arn=findings['support_role']
    )
    results['remediations'].append({
        'control': 'IAM.18',
        'findings': ['SEC-GENERAL-103'],
        'result': support_result
    })
    
    status_icon = '✅' if support_result['status'] in ['COMPLIANT', 'REMEDIATED'] else '❌'
    print(f"{status_icon} {support_result['status']}: {support_result['message']}")
    print("")
    
    # Summary
    print("=" * 80)
    print("📊 BULK REMEDIATION SUMMARY")
    print("=" * 80)
    
    total = len(results['remediations'])
    successful = sum(1 for r in results['remediations'] if r['result']['status'] in ['COMPLIANT', 'REMEDIATED'])
    failed = total - successful
    
    print(f"Total Remediations: {total}")
    print(f"✅ Successful: {successful}")
    print(f"❌ Failed: {failed}")
    print(f"Success Rate: {(successful/total*100):.1f}%")
    print("")
    
    # Findings addressed
    print("📋 Findings Addressed:")
    for remediation in results['remediations']:
        status = remediation['result']['status']
        icon = '✅' if status in ['COMPLIANT', 'REMEDIATED'] else '❌'
        for finding in remediation['findings']:
            print(f"  {icon} {finding} ({remediation['control']}): {status}")
    
    print("=" * 80)
    
    return results

def main():
    parser = argparse.ArgumentParser(description='Bulk IAM Policy Remediation')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    
    args = parser.parse_args()
    
    results = bulk_remediate_iam(
        profile_name=args.profile,
        region=args.region,
        dry_run=args.dry_run
    )
    
    # Exit with appropriate code
    successful = sum(1 for r in results['remediations'] if r['result']['status'] in ['COMPLIANT', 'REMEDIATED'])
    total = len(results['remediations'])
    
    return 0 if successful == total else 1

if __name__ == '__main__':
    exit(main())
