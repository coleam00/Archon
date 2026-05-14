#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
Remove MFA Enforcement Policy
Detaches the enforcement policy from users who have enabled MFA
"""

import boto3
import argparse

def remove_enforcement_from_user(iam_client, username, policy_arn, dry_run=False):
    """Remove enforcement policy if user has MFA enabled"""
    
    try:
        # Check MFA status
        mfa_devices = iam_client.list_mfa_devices(UserName=username)
        has_mfa = len(mfa_devices['MFADevices']) > 0
        
        if not has_mfa:
            print(f"⏭️  {username}: No MFA enabled yet, keeping policy")
            return {'status': 'SKIP', 'message': 'No MFA enabled'}
        
        if dry_run:
            print(f"[DRY RUN] {username}: Would remove enforcement policy (MFA enabled)")
            return {'status': 'DRY_RUN', 'message': 'Would remove policy'}
        
        # Detach policy
        iam_client.detach_user_policy(
            UserName=username,
            PolicyArn=policy_arn
        )
        
        print(f"✅ {username}: Removed enforcement policy (MFA enabled)")
        return {'status': 'REMOVED', 'message': 'Policy removed'}
        
    except Exception as e:
        print(f"❌ {username}: Error - {str(e)}")
        return {'status': 'ERROR', 'message': str(e)}

def main():
    parser = argparse.ArgumentParser(description='Remove MFA enforcement from users with MFA')
    parser.add_argument('--profile', default='default', help='AWS profile')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--users', nargs='+', required=True, help='IAM usernames')
    parser.add_argument('--dry-run', action='store_true', help='Dry run')
    parser.add_argument('--policy-name', default='EnforceMFAWithSetupAccess', help='Policy name')
    
    args = parser.parse_args()
    
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    iam_client = session.client('iam')
    sts_client = session.client('sts')
    
    account_id = sts_client.get_caller_identity()['Account']
    policy_arn = f"arn:aws:iam::{account_id}:policy/{args.policy_name}"
    
    print("=" * 80)
    print("🔓 REMOVE MFA ENFORCEMENT POLICY")
    print("=" * 80)
    print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE'}")
    print(f"Users: {', '.join(args.users)}")
    print("=" * 80)
    print("")
    
    results = []
    for username in args.users:
        result = remove_enforcement_from_user(iam_client, username, policy_arn, args.dry_run)
        results.append({'username': username, **result})
    
    print("\n" + "=" * 80)
    print("📊 SUMMARY")
    print("=" * 80)
    
    removed = sum(1 for r in results if r['status'] == 'REMOVED')
    skipped = sum(1 for r in results if r['status'] == 'SKIP')
    
    print(f"✅ Removed: {removed}")
    print(f"⏭️  Skipped (no MFA): {skipped}")
    print("=" * 80)
    
    return 0

if __name__ == '__main__':
    exit(main())
