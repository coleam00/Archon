#!/usr/bin/env python3
"""
Cleanup stale encrypted credentials that can't be decrypted with current SUPABASE_SERVICE_KEY.

This script runs during bootstrap to prevent silent decryption failures when the
encryption key changes (e.g., fresh Supabase init, key rotation).

Usage:
    python cleanup_stale_credentials.py

Environment variables:
    DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME - Database connection
    SUPABASE_SERVICE_KEY - Used to derive encryption key
"""

import base64
import os
import sys

import psycopg2

# Encryption imports - same as credential_service.py
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


def get_encryption_key() -> bytes:
    """Generate encryption key from SUPABASE_SERVICE_KEY - mirrors credential_service.py"""
    service_key = os.getenv("SUPABASE_SERVICE_KEY", "default-key-for-development")

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"static_salt_for_credentials",  # Must match credential_service.py
        iterations=100000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(service_key.encode()))
    return key


def try_decrypt(encrypted_value: str, fernet: Fernet) -> bool:
    """Attempt to decrypt a value, return True if successful."""
    if not encrypted_value:
        return True  # Empty values are fine

    try:
        encrypted_bytes = base64.urlsafe_b64decode(encrypted_value.encode("utf-8"))
        fernet.decrypt(encrypted_bytes)
        return True
    except (InvalidToken, ValueError, Exception):
        return False


def main():
    # Database connection from environment
    db_config = {
        "host": os.getenv("DB_HOST", "localhost"),
        "port": int(os.getenv("DB_PORT", "5432")),
        "user": os.getenv("DB_USER", "postgres"),
        "password": os.getenv("DB_PASSWORD", "postgres"),
        "dbname": os.getenv("DB_NAME", "postgres"),
    }

    service_key = os.getenv("SUPABASE_SERVICE_KEY")
    if not service_key:
        print("⚠ SUPABASE_SERVICE_KEY not set, skipping credential cleanup")
        return 0

    try:
        conn = psycopg2.connect(**db_config)
        conn.autocommit = True
        cursor = conn.cursor()
    except Exception as e:
        print(f"⚠ Could not connect to database: {e}")
        return 0  # Non-fatal - migrations may not have run yet

    # Check if table exists
    cursor.execute("""
        SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_name = 'archon_settings'
        )
    """)
    if not cursor.fetchone()[0]:
        print("✓ archon_settings table doesn't exist yet, skipping credential cleanup")
        conn.close()
        return 0

    # Get all encrypted credentials
    cursor.execute("""
        SELECT key, encrypted_value
        FROM archon_settings
        WHERE is_encrypted = true AND encrypted_value IS NOT NULL AND encrypted_value != ''
    """)
    encrypted_credentials = cursor.fetchall()

    if not encrypted_credentials:
        print("✓ No encrypted credentials to validate")
        conn.close()
        return 0

    # Create Fernet cipher with current key
    try:
        encryption_key = get_encryption_key()
        fernet = Fernet(encryption_key)
    except Exception as e:
        print(f"⚠ Could not create encryption cipher: {e}")
        conn.close()
        return 0

    # Test each credential
    stale_keys = []
    valid_count = 0

    for key, encrypted_value in encrypted_credentials:
        if try_decrypt(encrypted_value, fernet):
            valid_count += 1
        else:
            stale_keys.append(key)

    # Delete stale credentials
    if stale_keys:
        print(f"⚠ Found {len(stale_keys)} stale encrypted credential(s) that cannot be decrypted:")
        for key in stale_keys:
            print(f"  - {key}")

        # Delete them
        cursor.execute(
            "DELETE FROM archon_settings WHERE key = ANY(%s)",
            (stale_keys,)
        )
        print(f"✓ Deleted {len(stale_keys)} stale credential(s). Re-enter them in the Settings UI.")

    if valid_count > 0:
        print(f"✓ Validated {valid_count} encrypted credential(s)")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
