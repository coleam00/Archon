#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
APIGateway.3 Remediation: API Gateway REST API stages should have AWS X-Ray tracing enabled
IAM-Safe approach: Only enable if not already configured, preserve existing stage configuration
"""

import boto3
import json
import argparse
from datetime import datetime
from botocore.exceptions import ClientError

def verify_apigateway_xray_compliance(apigateway_client, api_id, stage_name):
    """Verify that API Gateway stage has X-Ray tracing enabled"""
    try:
        stage_response = apigateway_client.get_stage(restApiId=api_id, stageName=stage_name)
        tracing_config = stage_response.get('tracingConfig', {})
        tracing_enabled = tracing_config.get('tracingEnabled', False)
        
        return {
            'overall_compliant': tracing_enabled,
            'settings': {
                'xray_tracing': {
                    'required': True,
                    'actual': tracing_enabled,
                    'compliant': tracing_enabled
                }
            },
            'verification_timestamp': datetime.now().isoformat()
        }
        
    except Exception as e:
        return {
            'overall_compliant': False,
            'error': f'Verification failed: {str(e)}',
            'verification_timestamp': datetime.now().isoformat()
        }

def update_security_hub_finding_status(finding_arn, status, note, profile_name, region):
    """Update Security Hub finding status to RESOLVED"""
    try:
        session = boto3.Session(profile_name=profile_name)
        securityhub = session.client('securityhub', region_name=region)
        
        findings_response = securityhub.get_findings(
            Filters={'Id': [{'Value': finding_arn, 'Comparison': 'EQUALS'}]}
        )
        
        if not findings_response.get('Findings'):
            raise ValueError(f"Finding not found: {finding_arn}")
        
        finding = findings_response['Findings'][0]
        product_arn = finding.get('ProductArn')
        
        if not product_arn:
            raise ValueError(f"ProductArn not found in finding: {finding_arn}")
        
        response = securityhub.batch_update_findings(
            FindingIdentifiers=[{'Id': finding_arn, 'ProductArn': product_arn}],
            Workflow={'Status': status},
            Note={'Text': note, 'UpdatedBy': 'Security Compliance Remediation Framework'}
        )
        
        return {'success': True, 'finding_arn': finding_arn, 'new_status': status}
        
    except Exception as e:
        return {'success': False, 'finding_arn': finding_arn, 'error': f'Security Hub update failed: {str(e)}'}

def remediate_apigateway_xray_iam_safe(api_id, stage_name, profile_name, region, dry_run=False, finding_arn=None):
    """
    IAM-Safe APIGateway.3 remediation: Only enable X-Ray if not already configured
    Preserves existing stage configuration
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        apigateway = session.client('apigateway', region_name=region)
        
        # Check if API and stage exist
        try:
            stage_response = apigateway.get_stage(restApiId=api_id, stageName=stage_name)
        except ClientError as e:
            if e.response['Error']['Code'] == 'NotFoundException':
                return {
                    'api_id': api_id,
                    'stage_name': stage_name,
                    'control_id': 'APIGateway.3',
                    'status': 'ERROR',
                    'message': f'API {api_id} or stage {stage_name} not found',
                    'timestamp': datetime.now().isoformat()
                }
            raise
        
        # IAM-SAFE: Check existing X-Ray tracing configuration
        tracing_config = stage_response.get('tracingConfig', {})
        tracing_enabled = tracing_config.get('tracingEnabled', False)
        
        result = {
            'api_id': api_id,
            'stage_name': stage_name,
            'control_id': 'APIGateway.3',
            'timestamp': datetime.now().isoformat(),
            'existing_tracing': tracing_enabled,
            'iam_safe_approach': True
        }
        
        if tracing_enabled:
            result['status'] = 'COMPLIANT'
            result['message'] = f'X-Ray tracing already enabled for API {api_id} stage {stage_name}'
            result['needs_remediation'] = False
            
            verification = verify_apigateway_xray_compliance(apigateway, api_id, stage_name)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    f'APIGateway.3 compliance verified: X-Ray tracing already enabled for API {api_id} stage {stage_name} (IAM-Safe validation)',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would enable X-Ray tracing for API {api_id} stage {stage_name}'
            return result
        
        # IAM-SAFE: Enable X-Ray tracing using boto3 client method
        patch_operations = [
            {
                'op': 'replace',
                'path': '/tracingEnabled',
                'value': 'true'
            }
        ]
        
        apigateway.update_stage(
            restApiId=api_id,
            stageName=stage_name,
            patchOperations=patch_operations
        )
        
        result['status'] = 'REMEDIATED'
        result['message'] = f'IAM-Safe: Enabled X-Ray tracing for API {api_id} stage {stage_name}'
        result['needs_remediation'] = True
        
        # Verify remediation was successful
        verification = verify_apigateway_xray_compliance(apigateway, api_id, stage_name)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    f'APIGateway.3 remediation completed (IAM-Safe): Enabled X-Ray tracing for API {api_id} stage {stage_name}',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
            result['message'] = f'X-Ray tracing enabled but verification failed for API {api_id} stage {stage_name}'
        
        return result
        
    except Exception as e:
        return {
            'api_id': api_id,
            'stage_name': stage_name,
            'control_id': 'APIGateway.3',
            'status': 'ERROR',
            'message': f'IAM-Safe remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='APIGateway.3 X-Ray Tracing Remediation (IAM-Safe)')
    parser.add_argument('--api-id', required=True, help='API Gateway REST API ID')
    parser.add_argument('--stage-name', required=True, help='API Gateway stage name')
    parser.add_argument('--profile', default='com-r', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 APIGateway.3 Remediation: X-Ray Tracing (IAM-Safe)")
    print(f"API: {args.api_id}, Stage: {args.stage_name}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    if args.finding_id:
        print(f"Finding: {args.finding_id}")
    print("")
    
    result = remediate_apigateway_xray_iam_safe(
        api_id=args.api_id,
        stage_name=args.stage_name,
        profile_name=args.profile,
        region=args.region,
        dry_run=args.dry_run,
        finding_arn=args.finding_id
    )
    
    status_icons = {
        'COMPLIANT': '✅',
        'REMEDIATED': '✅',
        'DRY_RUN': '🔍',
        'ERROR': '❌',
        'REMEDIATION_FAILED': '⚠️'
    }
    
    icon = status_icons.get(result['status'], '❓')
    print(f"{icon} {result['status']}: {result['message']}")
    
    if result.get('existing_tracing') is not None:
        print(f"📋 Previous X-Ray tracing: {result['existing_tracing']}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: APIGateway.3 X-Ray tracing confirmed (IAM-Safe)")
        else:
            print(f"\n❌ VERIFICATION: APIGateway.3 X-Ray tracing failed")
            if verification.get('error'):
                print(f"   Error: {verification['error']}")
    
    if result.get('security_hub_update'):
        hub_update = result['security_hub_update']
        if hub_update.get('success'):
            print(f"\n🔗 SECURITY HUB: Finding marked as RESOLVED")
        else:
            print(f"\n❌ SECURITY HUB: Update failed - {hub_update.get('error')}")
    
    return 0 if result['status'] in ['COMPLIANT', 'REMEDIATED'] else 1

if __name__ == '__main__':
    exit(main())
