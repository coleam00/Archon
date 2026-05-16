#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
IAM MFA Enforcement via Managed Policy
Creates a managed policy and attaches to users
"""

import boto3
import json
import argparse
from datetime import datetime

MFA_ENFORCEMENT_POLICY = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AllowViewAccountInfo",
            "Effect": "Allow",
            "Action": [
                "iam:GetAccountPasswordPolicy",
                "iam:GetAccountSummary",
                "iam:ListVirtualMFADevices",
                "iam:ListUsers"
            ],
            "Resource": "*"
        },
        {
            "Sid": "AllowManageOwnAccount",
            "Effect": "Allow",
            "Action": [
                "iam:ChangePassword",
                "iam:GetUser",
                "iam:CreateAccessKey",
                "iam:DeleteAccessKey",
                "iam:ListAccessKeys",
                "iam:UpdateAccessKey",
                "iam:CreateVirtualMFADevice",
                "iam:DeleteVirtualMFADevice",
                "iam:DeactivateMFADevice",
                "iam:EnableMFADevice",
                "iam:ListMFADevices",
                "iam:ResyncMFADevice"
            ],
            "Resource": [
                "arn:aws:iam::*:user/${aws:username}",
                "arn:aws:iam::*:mfa/${aws:username}"
            ]
        },
        {
            "Sid": "DenyAllExceptMFASetup",
            "Effect": "Deny",
            "NotAction": [
                "iam:CreateVirtualMFADevice",
                "iam:EnableMFADevice",
                "iam:GetUser",
                "iam:ListMFADevices",
                "iam:ListVirtualMFADevices",
                "iam:ResyncMFADevice",
                "iam:ChangePassword",
                "iam:GetAccountPasswordPolicy",
                "iam:GetAccountSummary",
                "iam:ListUsers",
                "sts:GetSessionToken"
            ],
            "Resource": "*",
            "Condition": {
                "BoolIfExists": {
                    "aws:MultiFactorAuthPresent": "false"
                }
            }
        }
    ]
}

def create_or_update_managed_policy(iam_client, account_id, policy_name, dry_run=False):
    """Create or update the managed policy"""
    policy_arn = f"arn:aws:iam::{account_id}:policy/{policy_name}"
    
    try:
        # Check if policy exists
        try:
            policy = iam_client.get_policy(PolicyArn=policy_arn)
            print(f"✓ Policy {policy_name} already exists")
            return policy_arn
        except iam_client.exceptions.NoSuchEntityException:
            if dry_run:
                print(f"[DRY RUN] Would create policy: {policy_name}")
                return policy_arn
            
            # Create new policy
            response = iam_client.create_policy(
                PolicyName=policy_name,
                PolicyDocument=json.dumps(MFA_ENFORCEMENT_POLICY),
                Description="Enforces MFA while allowing console access for MFA setup"
            )
            print(f"✓ Created policy: {policy_name}")
            return response['Policy']['Arn']
    
    except Exception as e:
        print(f"✗ Error with policy: {str(e)}")
        return None

def attach_policy_to_user(iam_client, username, policy_arn, dry_run=False):
    """Attach managed policy to user"""
    result = {
        'username': username,
        'status': 'UNKNOWN',
        'message': '',
        'timestamp': datetime.now().isoformat()
    }
    
    try:
        # Check if user exists
        iam_client.get_user(UserName=username)
        print(f"✓ Found user: {username}")
        
        # Check MFA status
        mfa_devices = iam_client.list_mfa_devices(UserName=username)
        if len(mfa_devices['MFADevices']) > 0:
            result['status'] = 'COMPLIANT'
            result['message'] = f"User already has MFA enabled"
            print(f"✓ User already has MFA enabled")
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f"Would attach policy to {username}"
            print(f"[DRY RUN] Would attach policy to {username}")
            return result
        
        # Attach policy
        iam_client.attach_user_policy(
            UserName=username,
            PolicyArn=policy_arn
        )
        
        result['status'] = 'REMEDIATED'
        result['message'] = f"Successfully attached MFA enforcement policy"
        print(f"✓ Attached policy to {username}")
        
    except Exception as e:
        result['status'] = 'ERROR'
        result['message'] = f"Failed: {str(e)}"
        print(f"✗ Error: {str(e)}")
    
    return result

def main():
    parser = argparse.ArgumentParser(description='Enforce MFA via managed policy')
    parser.add_argument('--profile', default='default', help='AWS profile')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--users', nargs='+', required=True, help='IAM usernames')
    parser.add_argument('--dry-run', action='store_true', help='Dry run mode')
    parser.add_argument('--policy-name', default='EnforceMFAWithSetupAccess', help='Policy name')
    
    args = parser.parse_args()
    
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    iam_client = session.client('iam')
    sts_client = session.client('sts')
    
    # Get account ID
    account_id = sts_client.get_caller_identity()['Account']
    
    print("=" * 80)
    print("🔒 IAM MFA ENFORCEMENT (MANAGED POLICY)")
    print("=" * 80)
    print(f"Profile: {args.profile}")
    print(f"Account: {account_id}")
    print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE'}")
    print(f"Users: {', '.join(args.users)}")
    print("=" * 80)
    print("")
    
    # Create/get policy
    print("📋 Step 1: Create/Verify Managed Policy")
    print("-" * 80)
    policy_arn = create_or_update_managed_policy(iam_client, account_id, args.policy_name, args.dry_run)
    if not policy_arn:
        print("❌ Failed to create/get policy")
        return 1
    print("")
    
    # Attach to users
    print("📋 Step 2: Attach Policy to Users")
    print("-" * 80)
    results = []
    for username in args.users:
        print(f"\nProcessing: {username}")
        result = attach_policy_to_user(iam_client, username, policy_arn, args.dry_run)
        results.append(result)
    
    # Summary
    print("\n" + "=" * 80)
    print("📊 SUMMARY")
    print("=" * 80)
    
    remediated = sum(1 for r in results if r['status'] == 'REMEDIATED')
    compliant = sum(1 for r in results if r['status'] == 'COMPLIANT')
    errors = sum(1 for r in results if r['status'] == 'ERROR')
    
    print(f"Total: {len(results)}")
    print(f"✅ Remediated: {remediated}")
    print(f"✅ Compliant: {compliant}")
    print(f"❌ Errors: {errors}")
    print("")
    
    for result in results:
        icon = '✅' if result['status'] in ['REMEDIATED', 'COMPLIANT'] else '❌'
        print(f"  {icon} {result['username']}: {result['message']}")
    
    print("=" * 80)
    
    return 0 if errors == 0 else 1

if __name__ == '__main__':
    exit(main())
