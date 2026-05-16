#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
IAM MFA Enforcement with Setup Access
Remediates SEC-GENERAL-083, SEC-GENERAL-084, SEC-GENERAL-086, SEC-GENERAL-087

This script attaches a policy that:
1. Denies all actions EXCEPT MFA setup until MFA is enabled
2. Allows necessary IAM permissions to navigate console and setup MFA
3. Allows users to list IAM users, view their own account, and enable MFA
"""

import boto3
import json
import argparse
from datetime import datetime

# Policy that denies all actions except MFA setup
# Includes permissions needed to navigate AWS Console and setup MFA
MFA_ENFORCEMENT_POLICY = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AllowViewAccountInfo",
            "Effect": "Allow",
            "Action": [
                "iam:GetAccountPasswordPolicy",
                "iam:GetAccountSummary",
                "iam:ListVirtualMFADevices"
            ],
            "Resource": "*"
        },
        {
            "Sid": "AllowManageOwnPasswords",
            "Effect": "Allow",
            "Action": [
                "iam:ChangePassword",
                "iam:GetUser"
            ],
            "Resource": "arn:aws:iam::*:user/${aws:username}"
        },
        {
            "Sid": "AllowManageOwnAccessKeys",
            "Effect": "Allow",
            "Action": [
                "iam:CreateAccessKey",
                "iam:DeleteAccessKey",
                "iam:ListAccessKeys",
                "iam:UpdateAccessKey"
            ],
            "Resource": "arn:aws:iam::*:user/${aws:username}"
        },
        {
            "Sid": "AllowManageOwnSigningCertificates",
            "Effect": "Allow",
            "Action": [
                "iam:DeleteSigningCertificate",
                "iam:ListSigningCertificates",
                "iam:UpdateSigningCertificate",
                "iam:UploadSigningCertificate"
            ],
            "Resource": "arn:aws:iam::*:user/${aws:username}"
        },
        {
            "Sid": "AllowManageOwnSSHPublicKeys",
            "Effect": "Allow",
            "Action": [
                "iam:DeleteSSHPublicKey",
                "iam:GetSSHPublicKey",
                "iam:ListSSHPublicKeys",
                "iam:UpdateSSHPublicKey",
                "iam:UploadSSHPublicKey"
            ],
            "Resource": "arn:aws:iam::*:user/${aws:username}"
        },
        {
            "Sid": "AllowManageOwnGitCredentials",
            "Effect": "Allow",
            "Action": [
                "iam:CreateServiceSpecificCredential",
                "iam:DeleteServiceSpecificCredential",
                "iam:ListServiceSpecificCredentials",
                "iam:ResetServiceSpecificCredential",
                "iam:UpdateServiceSpecificCredential"
            ],
            "Resource": "arn:aws:iam::*:user/${aws:username}"
        },
        {
            "Sid": "AllowManageOwnVirtualMFADevice",
            "Effect": "Allow",
            "Action": [
                "iam:CreateVirtualMFADevice",
                "iam:DeleteVirtualMFADevice"
            ],
            "Resource": "arn:aws:iam::*:mfa/${aws:username}"
        },
        {
            "Sid": "AllowManageOwnUserMFA",
            "Effect": "Allow",
            "Action": [
                "iam:DeactivateMFADevice",
                "iam:EnableMFADevice",
                "iam:ListMFADevices",
                "iam:ResyncMFADevice"
            ],
            "Resource": "arn:aws:iam::*:user/${aws:username}"
        },
        {
            "Sid": "AllowListUsersForMFASetup",
            "Effect": "Allow",
            "Action": [
                "iam:ListUsers"
            ],
            "Resource": "*"
        },
        {
            "Sid": "DenyAllExceptListedIfNoMFA",
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

def enforce_mfa_for_user(iam_client, username, policy_name="EnforceMFAWithSetupAccess", dry_run=False):
    """
    Attach MFA enforcement policy to a specific IAM user
    
    Args:
        iam_client: Boto3 IAM client
        username: IAM username
        policy_name: Name for the inline policy
        dry_run: If True, only show what would be done
    
    Returns:
        dict: Result of the operation
    """
    result = {
        'username': username,
        'status': 'UNKNOWN',
        'message': '',
        'timestamp': datetime.now().isoformat()
    }
    
    try:
        # Check if user exists
        try:
            user_info = iam_client.get_user(UserName=username)
            print(f"✓ Found user: {username}")
        except iam_client.exceptions.NoSuchEntityException:
            result['status'] = 'ERROR'
            result['message'] = f"User {username} does not exist"
            return result
        
        # Check current MFA status
        mfa_devices = iam_client.list_mfa_devices(UserName=username)
        has_mfa = len(mfa_devices['MFADevices']) > 0
        
        if has_mfa:
            result['status'] = 'COMPLIANT'
            result['message'] = f"User {username} already has MFA enabled"
            print(f"✓ User {username} already has MFA enabled")
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f"Would attach MFA enforcement policy to {username}"
            print(f"[DRY RUN] Would attach policy '{policy_name}' to user {username}")
            print(f"[DRY RUN] Policy allows: IAM console navigation, user listing, and MFA setup")
            return result
        
        # Attach the policy
        iam_client.put_user_policy(
            UserName=username,
            PolicyName=policy_name,
            PolicyDocument=json.dumps(MFA_ENFORCEMENT_POLICY)
        )
        
        result['status'] = 'REMEDIATED'
        result['message'] = f"Successfully attached MFA enforcement policy to {username}"
        print(f"✓ Attached policy '{policy_name}' to user {username}")
        print(f"  User can now:")
        print(f"    - List IAM users to find their account")
        print(f"    - View their own user details")
        print(f"    - Setup and enable MFA")
        print(f"    - Change their password")
        print(f"  User CANNOT access other AWS services until MFA is enabled")
        
    except Exception as e:
        result['status'] = 'ERROR'
        result['message'] = f"Failed to attach policy: {str(e)}"
        print(f"✗ Error for user {username}: {str(e)}")
    
    return result

def main():
    parser = argparse.ArgumentParser(
        description='Enforce MFA for IAM users with console access permissions for setup'
    )
    parser.add_argument('--profile', default='default', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--users', nargs='+', required=True, help='IAM usernames to remediate')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--policy-name', default='EnforceMFAWithSetupAccess', 
                       help='Name for the inline policy')
    
    args = parser.parse_args()
    
    # Create session and client
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    iam_client = session.client('iam')
    
    print("=" * 80)
    print("🔒 IAM MFA ENFORCEMENT WITH SETUP ACCESS")
    print("=" * 80)
    print(f"Profile: {args.profile}")
    print(f"Region: {args.region}")
    print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE EXECUTION'}")
    print(f"Users: {', '.join(args.users)}")
    print(f"Policy: {args.policy_name}")
    print("=" * 80)
    print("")
    
    results = []
    for username in args.users:
        print(f"\n📋 Processing user: {username}")
        print("-" * 80)
        result = enforce_mfa_for_user(
            iam_client=iam_client,
            username=username,
            policy_name=args.policy_name,
            dry_run=args.dry_run
        )
        results.append(result)
        print("")
    
    # Summary
    print("=" * 80)
    print("📊 REMEDIATION SUMMARY")
    print("=" * 80)
    
    total = len(results)
    remediated = sum(1 for r in results if r['status'] == 'REMEDIATED')
    compliant = sum(1 for r in results if r['status'] == 'COMPLIANT')
    errors = sum(1 for r in results if r['status'] == 'ERROR')
    dry_run_count = sum(1 for r in results if r['status'] == 'DRY_RUN')
    
    print(f"Total Users: {total}")
    print(f"✅ Remediated: {remediated}")
    print(f"✅ Already Compliant: {compliant}")
    print(f"❌ Errors: {errors}")
    if dry_run_count > 0:
        print(f"🔍 Dry Run: {dry_run_count}")
    print("")
    
    print("📋 User Status:")
    for result in results:
        status_icon = {
            'REMEDIATED': '✅',
            'COMPLIANT': '✅',
            'ERROR': '❌',
            'DRY_RUN': '🔍'
        }.get(result['status'], '❓')
        print(f"  {status_icon} {result['username']}: {result['status']} - {result['message']}")
    
    print("=" * 80)
    
    # Exit code
    return 0 if errors == 0 else 1

if __name__ == '__main__':
    exit(main())
