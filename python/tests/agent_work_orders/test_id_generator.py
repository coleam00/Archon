"""Tests for ID Generator"""

from src.agent_work_orders.utils.id_generator import (
    generate_sandbox_identifier,
    generate_work_order_id,
)


def test_generate_work_order_id_format():
    """Test work order ID format"""
    work_order_id = generate_work_order_id()

    assert work_order_id.startswith("wo-")
    assert len(work_order_id) == 11  # "wo-" + 8 hex chars
    # Verify it's hex
    hex_part = work_order_id[3:]
    assert all(c in "0123456789abcdef" for c in hex_part)


def test_generate_work_order_id_uniqueness():
    """Test that generated IDs are unique"""
    ids = [generate_work_order_id() for _ in range(100)]
    assert len(ids) == len(set(ids))  # All unique


def test_generate_sandbox_identifier():
    """Test sandbox identifier generation"""
    work_order_id = "wo-test123"
    sandbox_id = generate_sandbox_identifier(work_order_id)

    assert sandbox_id == "sandbox-wo-test123"
    assert sandbox_id.startswith("sandbox-")
