#!/usr/bin/env python
"""Quick script to verify interface implementations."""

from archon.infrastructure.supabase import SupabaseSitePagesRepository
from archon.infrastructure.memory import InMemorySitePagesRepository
from archon.domain.interfaces import ISitePagesRepository

# Get interface methods
interface_methods = set([m for m in dir(ISitePagesRepository) if not m.startswith('_')])

# Check Supabase implementation
supabase_methods = set([m for m in dir(SupabaseSitePagesRepository) if not m.startswith('_')])
missing_supabase = interface_methods - supabase_methods

print("=== SupabaseSitePagesRepository ===")
print(f"Interface methods: {sorted(interface_methods)}")
print(f"Implementation methods: {sorted(supabase_methods)}")
if missing_supabase:
    print(f"MISSING: {missing_supabase}")
else:
    print("[OK] All interface methods implemented")

# Check InMemory implementation
print("\n=== InMemorySitePagesRepository ===")
memory_methods = set([m for m in dir(InMemorySitePagesRepository) if not m.startswith('_')])
missing_memory = interface_methods - memory_methods

print(f"Interface methods: {sorted(interface_methods)}")
print(f"Implementation methods: {sorted(memory_methods)}")
if missing_memory:
    print(f"MISSING: {missing_memory}")
else:
    print("[OK] All interface methods implemented")
