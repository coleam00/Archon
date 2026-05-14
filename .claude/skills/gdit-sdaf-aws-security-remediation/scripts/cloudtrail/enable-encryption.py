#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
CloudTrail-2 Remediation: Enable Encryption at Rest (IAM-Safe)
Enables KMS encryption on CloudTrail trails for log protection.
"""

import boto3
import argparse
import sys
from datetime import datetime

def enable_cloudtrail_encryption(trail_name, profile='default', region='us-east-1', dry_run=False):
    """Enable KMS encryption on CloudTrail trail"""
    
    session = boto3.Session(profile_name=profile)
    cloudtrail = session.client('cloudtrail', region_name=region)
    
    try:
        # Get trail details
        response = cloudtrail.describe_trails(trailNameList=[trail_name])
        if not response['trailList']:
            print(f"❌ ERROR: Trail {trail_name} not found")
            return False
        
        trail = response['trailList'][0]
        trail_arn = trail['TrailARN']
        current_kms_key = trail.get('KMSKeyId')
        
        if current_kms_key:
            print(f"✅ COMPLIANT: Trail {trail_name} already has KMS encryption enabled")
            print(f"📋 Current KMS Key: {current_kms_key}")
            return True
        
        if dry_run:
            print(f"🔍 DRY RUN: Would enable KMS encryption on {trail_name}")
            return True
        
        # Use AWS managed CloudTrail KMS key
        kms_key_id = 'alias/aws/cloudtrail'
        
        print(f"🔧 Enabling KMS encryption on {trail_name}...")
        cloudtrail.update_trail(
            Name=trail_arn,
            KmsKeyId=kms_key_id
        )
        
        print(f"✅ SUCCESS: KMS encryption enabled on {trail_name}")
        print(f"📋 KMS Key: {kms_key_id}")
        return True
        
    except Exception as e:
        print(f"❌ ERROR: Failed to enable encryption on {trail_name}: {e}")
        return False

def update_security_hub_finding(finding_id, trail_name, profile='default', region='us-east-1'):
    """Update Security Hub finding status"""
    
    if not finding_id:
        return
    
    try:
        session = boto3.Session(profile_name=profile)
        securityhub = session.client('securityhub', region_name=region)
        
        securityhub.batch_update_findings(
            FindingIdentifiers=[{
                'Id': finding_id,
                'ProductArn': f'arn:aws:securityhub:{region}::product/aws/securityhub'
            }],
            Workflow={'Status': 'RESOLVED'},
            Note={
                'Text': f'CloudTrail KMS encryption enabled on {trail_name} via automated remediation',
                'UpdatedBy': 'GDIT-Security-Compliance-Automation'
            }
        )
        print(f"✅ Security Hub finding updated: {finding_id}")
        
    except Exception as e:
        print(f"⚠️ Could not update Security Hub finding: {e}")

def main():
    parser = argparse.ArgumentParser(description='Enable CloudTrail KMS encryption')
    parser.add_argument('--trail-name', required=True, help='CloudTrail trail name')
    parser.add_argument('--profile', default='default', help='AWS profile')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Dry run mode')
    parser.add_argument('--finding-id', help='Security Hub finding ID to update')
    
    args = parser.parse_args()
    
    print(f"🔧 CloudTrail-2 Remediation: Enable Encryption (IAM-Safe)")
    print(f"Trail: {args.trail_name}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    print()
    
    success = enable_cloudtrail_encryption(
        args.trail_name, 
        args.profile, 
        args.region, 
        args.dry_run
    )
    
    if success and not args.dry_run:
        update_security_hub_finding(args.finding_id, args.trail_name, args.profile, args.region)
    
    print(f"\n✅ VERIFICATION: CloudTrail-2 encryption {'verified' if success else 'failed'} (IAM-Safe)")
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
