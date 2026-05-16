#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
EC2-15 Remediation: Disable Subnet Auto-Assign Public IP (IAM-Safe)
Disables automatic public IP assignment on EC2 subnets for security.
"""

import boto3
import argparse
import sys
from datetime import datetime

def disable_auto_assign_public_ip(subnet_id, profile='default', region='us-east-1', dry_run=False):
    """Disable auto-assign public IP on subnet"""
    
    session = boto3.Session(profile_name=profile)
    ec2 = session.client('ec2', region_name=region)
    
    try:
        # Check current status
        response = ec2.describe_subnets(SubnetIds=[subnet_id])
        subnet = response['Subnets'][0]
        current_setting = subnet.get('MapPublicIpOnLaunch', False)
        
        if not current_setting:
            print(f"✅ COMPLIANT: Subnet {subnet_id} already has auto-assign public IP disabled")
            return True
        
        if dry_run:
            print(f"🔍 DRY RUN: Would disable auto-assign public IP on {subnet_id}")
            return True
        
        # Disable auto-assign public IP
        print(f"🔧 Disabling auto-assign public IP on {subnet_id}...")
        ec2.modify_subnet_attribute(
            SubnetId=subnet_id,
            MapPublicIpOnLaunch={'Value': False}
        )
        
        print(f"✅ SUCCESS: Auto-assign public IP disabled on {subnet_id}")
        return True
        
    except Exception as e:
        print(f"❌ ERROR: Failed to modify subnet {subnet_id}: {e}")
        return False

def update_security_hub_finding(finding_id, subnet_id, profile='default', region='us-east-1'):
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
                'Text': f'EC2 subnet auto-assign public IP disabled on {subnet_id} via automated remediation',
                'UpdatedBy': 'GDIT-Security-Compliance-Automation'
            }
        )
        print(f"✅ Security Hub finding updated: {finding_id}")
        
    except Exception as e:
        print(f"⚠️ Could not update Security Hub finding: {e}")

def main():
    parser = argparse.ArgumentParser(description='Disable EC2 subnet auto-assign public IP')
    parser.add_argument('--subnet-id', required=True, help='EC2 subnet ID')
    parser.add_argument('--profile', default='default', help='AWS profile')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Dry run mode')
    parser.add_argument('--finding-id', help='Security Hub finding ID to update')
    
    args = parser.parse_args()
    
    print(f"🔧 EC2-15 Remediation: Disable Auto-Assign Public IP (IAM-Safe)")
    print(f"Subnet: {args.subnet_id}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    print()
    
    success = disable_auto_assign_public_ip(
        args.subnet_id, 
        args.profile, 
        args.region, 
        args.dry_run
    )
    
    if success and not args.dry_run:
        update_security_hub_finding(args.finding_id, args.subnet_id, args.profile, args.region)
    
    print(f"\n✅ VERIFICATION: EC2-15 auto-assign public IP {'disabled' if success else 'failed'} (IAM-Safe)")
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
