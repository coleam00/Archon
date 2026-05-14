#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
Bulk CloudWatch.15 Remediation: Fix all SecurityCompliance alarms missing actions
Uses existing SNS topic from CloudFormation: Marketplace-Messaging-dev
"""

import boto3
import subprocess
import sys
from datetime import datetime

def get_all_cloudwatch15_findings(profile_name, region):
    """Get all CloudWatch.15 findings that need remediation"""
    try:
        session = boto3.Session(profile_name=profile_name)
        securityhub = session.client('securityhub', region_name=region)
        
        # Get all HIGH severity CloudWatch.15 findings
        findings_response = securityhub.get_findings(
            Filters={
                'SeverityLabel': [{'Value': 'HIGH', 'Comparison': 'EQUALS'}],
                'Title': [{'Value': 'CloudWatch alarms should have specified actions configured', 'Comparison': 'EQUALS'}],
                'WorkflowStatus': [{'Value': 'NEW', 'Comparison': 'EQUALS'}]
            }
        )
        
        findings = []
        for finding in findings_response.get('Findings', []):
            resource_id = finding.get('Resources', [{}])[0].get('Id', '')
            if 'SecurityCompliance-' in resource_id:
                alarm_name = resource_id.split(':')[-1]  # Extract alarm name from ARN
                findings.append({
                    'finding_arn': finding['Id'],
                    'alarm_name': alarm_name,
                    'resource_arn': resource_id
                })
        
        return findings
        
    except Exception as e:
        print(f"❌ Error getting CloudWatch.15 findings: {str(e)}")
        return []

def execute_alarm_action_remediation(alarm_name, finding_arn, profile='com-r', environment='dev'):
    """Execute alarm action remediation for a single alarm"""
    
    script_path = 'specs/features/security-compliance/remediation-library/scripts/cloudwatch/configure-alarm-actions.py'
    
    cmd = [
        'python3', script_path,
        '--alarm-name', alarm_name,
        '--environment', environment,
        '--finding-id', finding_arn,
        '--profile', profile
    ]
    
    try:
        print(f"🔧 Fixing alarm: {alarm_name}")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        
        if result.returncode == 0:
            print(f"✅ {alarm_name}: SUCCESS")
            return {'alarm_name': alarm_name, 'status': 'SUCCESS', 'output': result.stdout}
        else:
            print(f"❌ {alarm_name}: FAILED")
            print(f"   Error: {result.stderr}")
            return {'alarm_name': alarm_name, 'status': 'FAILED', 'error': result.stderr}
            
    except subprocess.TimeoutExpired:
        print(f"⏰ {alarm_name}: TIMEOUT")
        return {'alarm_name': alarm_name, 'status': 'TIMEOUT', 'error': 'Script execution timed out'}
    except Exception as e:
        print(f"❌ {alarm_name}: ERROR - {str(e)}")
        return {'alarm_name': alarm_name, 'status': 'ERROR', 'error': str(e)}

def main():
    print("🚀 Bulk CloudWatch.15 Alarm Actions Remediation")
    print("===============================================")
    print(f"Timestamp: {datetime.now().isoformat()}")
    print("Target: Fix all SecurityCompliance alarms missing actions")
    print("Using existing SNS topic: Marketplace-Messaging-dev")
    print("")
    
    profile = 'com-r'
    region = 'us-east-1'
    environment = 'dev'
    
    # Get all CloudWatch.15 findings
    print("🔍 Discovering CloudWatch.15 findings...")
    findings = get_all_cloudwatch15_findings(profile, region)
    
    if not findings:
        print("✅ No CloudWatch.15 findings found or all already resolved")
        return 0
    
    print(f"📋 Found {len(findings)} CloudWatch.15 findings to remediate:")
    for finding in findings:
        print(f"   - {finding['alarm_name']}")
    print("")
    
    results = []
    successful = 0
    failed = 0
    
    for finding in findings:
        print(f"\n=== {finding['alarm_name']} ===")
        result = execute_alarm_action_remediation(
            finding['alarm_name'], 
            finding['finding_arn'], 
            profile, 
            environment
        )
        results.append(result)
        
        if result['status'] == 'SUCCESS':
            successful += 1
        else:
            failed += 1
    
    print(f"\n📊 BULK REMEDIATION SUMMARY")
    print(f"===========================")
    print(f"✅ Successful: {successful}/{len(findings)}")
    print(f"❌ Failed: {failed}/{len(findings)}")
    print(f"📈 Success Rate: {(successful/len(findings))*100:.1f}%")
    
    if successful > 0:
        print(f"\n🎯 RESULTS:")
        print(f"✅ Fixed {successful} CloudWatch alarms")
        print(f"✅ Added SNS actions using existing Marketplace topic")
        print(f"✅ Marked {successful} Security Hub findings as RESOLVED")
        print(f"✅ Maintained IAM-Safe approach (preserved existing configurations)")
    
    if failed > 0:
        print(f"\n⚠️ FAILURES:")
        for result in results:
            if result['status'] != 'SUCCESS':
                print(f"❌ {result['alarm_name']}: {result.get('error', 'Unknown error')}")
    
    print(f"\n✅ Bulk CloudWatch.15 Remediation Complete")
    return 0 if failed == 0 else 1

if __name__ == '__main__':
    exit(main())
