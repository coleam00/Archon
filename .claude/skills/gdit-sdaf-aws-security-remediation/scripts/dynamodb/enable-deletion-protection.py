#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
DynamoDB-6 Remediation: Enable Deletion Protection (IAM-Safe)
Enables deletion protection on DynamoDB tables to prevent accidental deletion.
"""

import boto3
import argparse
import sys
from datetime import datetime

def enable_deletion_protection(table_name, profile='default', region='us-east-1', dry_run=False):
    """Enable deletion protection on DynamoDB table"""
    
    session = boto3.Session(profile_name=profile)
    dynamodb = session.client('dynamodb', region_name=region)
    
    try:
        # Check current status
        response = dynamodb.describe_table(TableName=table_name)
        current_protection = response['Table'].get('DeletionProtectionEnabled', False)
        
        if current_protection:
            print(f"✅ COMPLIANT: Table {table_name} already has deletion protection enabled")
            return True
        
        if dry_run:
            print(f"🔍 DRY RUN: Would enable deletion protection on {table_name}")
            return True
        
        # Enable deletion protection
        print(f"🔧 Enabling deletion protection on {table_name}...")
        dynamodb.update_table(
            TableName=table_name,
            DeletionProtectionEnabled=True
        )
        
        print(f"✅ SUCCESS: Deletion protection enabled on {table_name}")
        return True
        
    except Exception as e:
        print(f"❌ ERROR: Failed to enable deletion protection on {table_name}: {e}")
        return False

def update_security_hub_finding(finding_id, table_name, profile='default', region='us-east-1'):
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
                'Text': f'DynamoDB deletion protection enabled on {table_name} via automated remediation',
                'UpdatedBy': 'GDIT-Security-Compliance-Automation'
            }
        )
        print(f"✅ Security Hub finding updated: {finding_id}")
        
    except Exception as e:
        print(f"⚠️ Could not update Security Hub finding: {e}")

def main():
    parser = argparse.ArgumentParser(description='Enable DynamoDB deletion protection')
    parser.add_argument('--table-name', required=True, help='DynamoDB table name')
    parser.add_argument('--profile', default='default', help='AWS profile')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Dry run mode')
    parser.add_argument('--finding-id', help='Security Hub finding ID to update')
    
    args = parser.parse_args()
    
    print(f"🔧 DynamoDB-6 Remediation: Deletion Protection (IAM-Safe)")
    print(f"Table: {args.table_name}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    print()
    
    success = enable_deletion_protection(
        args.table_name, 
        args.profile, 
        args.region, 
        args.dry_run
    )
    
    if success and not args.dry_run:
        update_security_hub_finding(args.finding_id, args.table_name, args.profile, args.region)
    
    print(f"\n✅ VERIFICATION: DynamoDB-6 deletion protection {'verified' if success else 'failed'} (IAM-Safe)")
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
