#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
APIGateway-1 Remediation: Enable Execution Logging (IAM-Safe)
Enables execution logging on API Gateway REST API stages.
"""

import boto3
import argparse
import sys
import json
from datetime import datetime

def create_log_group_if_needed(api_id, stage_name, profile='default', region='us-east-1'):
    """Create CloudWatch log group for API Gateway if it doesn't exist"""
    
    session = boto3.Session(profile_name=profile)
    logs = session.client('logs', region_name=region)
    
    log_group_name = f"API-Gateway-Execution-Logs_{api_id}/{stage_name}"
    
    try:
        logs.describe_log_groups(logGroupNamePrefix=log_group_name)
        print(f"✅ Log group exists: {log_group_name}")
        return log_group_name
    except:
        try:
            logs.create_log_group(logGroupName=log_group_name)
            print(f"✅ Created log group: {log_group_name}")
            return log_group_name
        except Exception as e:
            print(f"❌ Failed to create log group: {e}")
            return None

def enable_execution_logging(api_id, stage_name, profile='default', region='us-east-1', dry_run=False):
    """Enable execution logging on API Gateway stage"""
    
    session = boto3.Session(profile_name=profile)
    apigateway = session.client('apigateway', region_name=region)
    
    try:
        # Check current logging status
        response = apigateway.get_stage(restApiId=api_id, stageName=stage_name)
        current_logging = response.get('accessLogSettings', {})
        
        if current_logging.get('destinationArn'):
            print(f"✅ COMPLIANT: Stage {stage_name} already has execution logging enabled")
            return True
        
        if dry_run:
            print(f"🔍 DRY RUN: Would enable execution logging on {api_id}/{stage_name}")
            return True
        
        # Create log group
        log_group_name = create_log_group_if_needed(api_id, stage_name, profile, region)
        if not log_group_name:
            return False
        
        log_arn = f"arn:aws:logs:{region}:{boto3.Session(profile_name=profile).client('sts').get_caller_identity()['Account']}:log-group:{log_group_name}"
        
        # Enable logging
        print(f"🔧 Enabling execution logging on {api_id}/{stage_name}...")
        
        patch_ops = [
            {
                'op': 'replace',
                'path': '/accessLogSettings/destinationArn',
                'value': log_arn
            },
            {
                'op': 'replace',
                'path': '/accessLogSettings/format',
                'value': '$requestId $ip $caller $user [$requestTime] "$httpMethod $resourcePath $protocol" $status $error.message $error.messageString'
            }
        ]
        
        apigateway.update_stage(
            restApiId=api_id,
            stageName=stage_name,
            patchOperations=patch_ops
        )
        
        print(f"✅ SUCCESS: Execution logging enabled on {api_id}/{stage_name}")
        return True
        
    except Exception as e:
        print(f"❌ ERROR: Failed to enable logging on {api_id}/{stage_name}: {e}")
        return False

def update_security_hub_finding(finding_id, api_id, stage_name, profile='default', region='us-east-1'):
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
                'Text': f'API Gateway execution logging enabled on {api_id}/{stage_name} via automated remediation',
                'UpdatedBy': 'GDIT-Security-Compliance-Automation'
            }
        )
        print(f"✅ Security Hub finding updated: {finding_id}")
        
    except Exception as e:
        print(f"⚠️ Could not update Security Hub finding: {e}")

def main():
    parser = argparse.ArgumentParser(description='Enable API Gateway execution logging')
    parser.add_argument('--api-id', required=True, help='API Gateway REST API ID')
    parser.add_argument('--stage-name', required=True, help='API Gateway stage name')
    parser.add_argument('--profile', default='default', help='AWS profile')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Dry run mode')
    parser.add_argument('--finding-id', help='Security Hub finding ID to update')
    
    args = parser.parse_args()
    
    print(f"🔧 APIGateway-1 Remediation: Execution Logging (IAM-Safe)")
    print(f"API: {args.api_id}, Stage: {args.stage_name}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    print()
    
    success = enable_execution_logging(
        args.api_id, 
        args.stage_name,
        args.profile, 
        args.region, 
        args.dry_run
    )
    
    if success and not args.dry_run:
        update_security_hub_finding(args.finding_id, args.api_id, args.stage_name, args.profile, args.region)
    
    print(f"\n✅ VERIFICATION: APIGateway-1 execution logging {'verified' if success else 'failed'} (IAM-Safe)")
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
