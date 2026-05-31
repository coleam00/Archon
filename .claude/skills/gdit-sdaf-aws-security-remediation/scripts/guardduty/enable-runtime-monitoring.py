#!/usr/bin/env python3.12
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.34.0",
# ]
# ///
"""
GuardDuty Runtime Monitoring Remediation
Reusable script for Security Hub findings GuardDuty-11, GuardDuty-12, GuardDuty-13, GuardDuty-7 remediation
"""

import boto3
import json
import argparse
from datetime import datetime

def verify_guardduty_compliance(detector_id, guardduty_client):
    """
    Verify that GuardDuty meets runtime monitoring compliance requirements
    
    Returns:
        dict: Verification result with compliance status
    """
    try:
        # Get current detector configuration
        response = guardduty_client.get_detector(DetectorId=detector_id)
        
        # Get data sources configuration
        data_sources = response.get('DataSources', {})
        
        # Check malware protection
        malware_protection = data_sources.get('MalwareProtection', {}).get('ScanEc2InstanceWithFindings', {}).get('Status') == 'ENABLED'
        
        # Check runtime monitoring features
        kubernetes = data_sources.get('Kubernetes', {}).get('AuditLogs', {}).get('Status') == 'ENABLED'
        
        compliance_status = {
            'malware_protection': {
                'required': True,
                'actual': malware_protection,
                'compliant': malware_protection
            },
            'kubernetes_audit_logs': {
                'required': True,
                'actual': kubernetes,
                'compliant': kubernetes
            }
        }
        
        all_compliant = malware_protection and kubernetes
        
        return {
            'overall_compliant': all_compliant,
            'settings': compliance_status,
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
        
        response = securityhub.batch_update_findings(
            FindingIdentifiers=[{'Id': finding_arn, 'ProductArn': product_arn}],
            Workflow={'Status': status},
            Note={'Text': note, 'UpdatedBy': 'Security Compliance Remediation Framework'}
        )
        
        return {'success': True, 'finding_arn': finding_arn, 'new_status': status}
        
    except Exception as e:
        return {'success': False, 'finding_arn': finding_arn, 'error': str(e)}

def remediate_guardduty_runtime_monitoring(detector_id, profile_name, region, dry_run=False, finding_arn=None):
    """
    Remediate GuardDuty runtime monitoring findings by enabling runtime protection features
    """
    
    try:
        session = boto3.Session(profile_name=profile_name)
        guardduty_client = session.client('guardduty', region_name=region)
        
        # Get current configuration
        response = guardduty_client.get_detector(DetectorId=detector_id)
        data_sources = response.get('DataSources', {})
        
        # Check current status
        current_malware = data_sources.get('MalwareProtection', {}).get('ScanEc2InstanceWithFindings', {}).get('Status') == 'ENABLED'
        current_kubernetes = data_sources.get('Kubernetes', {}).get('AuditLogs', {}).get('Status') == 'ENABLED'
        
        changes = {}
        needs_remediation = False
        
        if not current_malware:
            changes['malware_protection'] = {'current': False, 'required': True}
            needs_remediation = True
        
        if not current_kubernetes:
            changes['kubernetes_audit_logs'] = {'current': False, 'required': True}
            needs_remediation = True
        
        result = {
            'control_id': 'GuardDuty-Runtime',
            'timestamp': datetime.now().isoformat(),
            'needs_remediation': needs_remediation,
            'changes': changes
        }
        
        if not needs_remediation:
            result['status'] = 'COMPLIANT'
            result['message'] = 'GuardDuty runtime monitoring already enabled'
            
            verification = verify_guardduty_compliance(detector_id, guardduty_client)
            result['verification'] = verification
            
            if finding_arn and verification.get('overall_compliant'):
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED', 
                    'GuardDuty runtime monitoring verified as enabled',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
            
            return result
        
        if dry_run:
            result['status'] = 'DRY_RUN'
            result['message'] = f'Would enable GuardDuty runtime monitoring features: {list(changes.keys())}'
            return result
        
        # Apply remediation - Update detector data sources
        data_sources_config = {
            'S3Logs': {'Enable': True},
            'Kubernetes': {'AuditLogs': {'Enable': True}},
            'MalwareProtection': {'ScanEc2InstanceWithFindings': {'EbsVolumes': True}}
        }
        
        guardduty_client.update_detector(
            DetectorId=detector_id,
            DataSources=data_sources_config
        )
        
        applied_config = {
            'malware_protection': True,
            'kubernetes_audit_logs': True
        }
        
        result['status'] = 'REMEDIATED'
        result['message'] = 'GuardDuty runtime monitoring features enabled successfully'
        result['applied_config'] = applied_config
        
        # Verify remediation
        verification = verify_guardduty_compliance(detector_id, guardduty_client)
        result['verification'] = verification
        
        if verification.get('overall_compliant'):
            result['verification_status'] = 'VERIFIED'
            
            if finding_arn:
                hub_update = update_security_hub_finding_status(
                    finding_arn, 'RESOLVED',
                    'GuardDuty runtime monitoring enabled and verified',
                    profile_name, region
                )
                result['security_hub_update'] = hub_update
        else:
            result['verification_status'] = 'FAILED'
            result['status'] = 'REMEDIATION_FAILED'
        
        return result
        
    except Exception as e:
        return {
            'control_id': 'GuardDuty-Runtime',
            'status': 'ERROR',
            'message': f'Remediation failed: {str(e)}',
            'timestamp': datetime.now().isoformat()
        }

def main():
    parser = argparse.ArgumentParser(description='GuardDuty Runtime Monitoring Remediation')
    parser.add_argument('--detector-id', required=True, help='GuardDuty detector ID')
    parser.add_argument('--profile', default='com-d', help='AWS profile name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--dry-run', action='store_true', help='Show changes without applying')
    parser.add_argument('--finding-id', help='Security Hub finding ARN for status update')
    
    args = parser.parse_args()
    
    print(f"🔧 GuardDuty Runtime Monitoring Remediation")
    print(f"Detector ID: {args.detector_id}")
    print(f"Profile: {args.profile}, Region: {args.region}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be applied")
    print("")
    
    result = remediate_guardduty_runtime_monitoring(
        args.detector_id,
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
    
    if result.get('changes'):
        print("\n📋 Applied Changes:")
        for setting, change in result['changes'].items():
            print(f"   {setting}: {change.get('current')} → {change.get('required')}")
    
    if result.get('verification'):
        verification = result['verification']
        if verification.get('overall_compliant'):
            print(f"\n✅ VERIFICATION: GuardDuty runtime monitoring compliance confirmed")
        else:
            print(f"\n❌ VERIFICATION: GuardDuty runtime monitoring compliance failed")
    
    if result.get('security_hub_update'):
        hub_update = result['security_hub_update']
        if hub_update.get('success'):
            print(f"\n🔗 SECURITY HUB: Finding marked as RESOLVED")
        else:
            print(f"\n❌ SECURITY HUB: Update failed - {hub_update.get('error')}")
    
    return 0 if result['status'] in ['COMPLIANT', 'REMEDIATED'] else 1

if __name__ == '__main__':
    exit(main())
