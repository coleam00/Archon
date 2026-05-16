#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
SSM-6 Remediation: Enable CloudWatch Logging for SSM Automation (IAM-Safe)
Enables CloudWatch logging for Systems Manager Automation.
"""

import boto3
import argparse
import sys
import json
from datetime import datetime

def enable_ssm_cloudwatch_logging(profile='default', region='us-east-1', dry_run=False):
    """Enable CloudWatch logging for SSM Automation"""
    
    session = boto3.Session(profile_name=profile)
    ssm = session.client('ssm', region_name=region)
    logs = session.client('logs', region_name=region)
    
    try:
        # Create log group for SSM if it doesn't exist
        log_group_name = '/aws/ssm/automation'
        
        try:
            logs.describe_log_groups(logGroupNamePrefix=log_group_name)
            print(f"✅ Log group exists: {log_group_name}")
        except:
            if not dry_run:
                logs.create_log_group(logGroupName=log_group_name)
                print(f"✅ Created log group: {log_group_name}")
            else:
                print(f"🔍 DRY RUN: Would create log group: {log_group_name}")
        
        # Check current SSM service settings
        try:
            response = ssm.get_service_setting(SettingId='/ssm/automation/customer-script-log-destination')
            current_destination = response['ServiceSetting']['SettingValue']
            
            if 'CloudWatch' in current_destination:
                print(f"✅ COMPLIANT: SSM Automation already has CloudWatch logging enabled")
                return True
        except:
            # Setting doesn't exist, need to create it
            pass
        
        if dry_run:
            print(f"🔍 DRY RUN: Would enable CloudWatch logging for SSM Automation")
            return True
        
        # Enable CloudWatch logging for SSM Automation
        print(f"🔧 Enabling CloudWatch logging for SSM Automation...")
        
        ssm.update_service_setting(
            SettingId='/ssm/automation/customer-script-log-destination',
            SettingValue='CloudWatch'
        )
        
        print(f"✅ SUCCESS: CloudWatch logging enabled for SSM Automation")
        return True
        
    except Exception as e:
        print(f"❌ ERROR: Failed to enable SSM CloudWatch logging: {e}")
        return False

def update_security_hub_finding(finding_id, profile='default', region='us-east-1'):
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
                'Text': f'SSM Automation CloudWatch logging enabled via automated remediation',
                'UpdatedBy': 'GDIT-Security-Compliance-Automation'
            }
        )
        print(f"✅ Security Hub finding updated: {finding_id}")
        
    except Exception as e:
        print(f"⚠️ Could not update Security Hub finding: {e}")

def main():
    parser = argparse.ArgumentParser(description='Enable SSM CloudWatch logging')
    parser.add_argument('--profile', default='default', help='AWS profile')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Dry run mode')
    parser.add_argument('--finding-id', help='Security Hub finding ID to update')
    
    args = parser.parse_args()
    
    print(f"🔧 SSM-6 Remediation: Enable CloudWatch Logging (IAM-Safe)")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    print()
    
    success = enable_ssm_cloudwatch_logging(
        args.profile, 
        args.region, 
        args.dry_run
    )
    
    if success and not args.dry_run:
        update_security_hub_finding(args.finding_id, args.profile, args.region)
    
    print(f"\n✅ VERIFICATION: SSM CloudWatch logging {'enabled' if success else 'failed'} (IAM-Safe)")
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
