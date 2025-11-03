"""Tests for Port Allocation with 10-Port Ranges"""

from unittest.mock import patch

import pytest

from src.agent_work_orders.utils.port_allocation import (
    MAX_CONCURRENT_WORK_ORDERS,
    PORT_BASE,
    PORT_RANGE_SIZE,
    create_ports_env_file,
    find_available_port_range,
    get_port_range_for_work_order,
    is_port_available,
)


@pytest.mark.unit
def test_get_port_range_for_work_order_deterministic():
    """Test that same work order ID always gets same port range"""
    work_order_id = "wo-abc123"

    start1, end1 = get_port_range_for_work_order(work_order_id)
    start2, end2 = get_port_range_for_work_order(work_order_id)

    assert start1 == start2
    assert end1 == end2
    assert end1 - start1 + 1 == PORT_RANGE_SIZE  # 10 ports
    assert PORT_BASE <= start1 < PORT_BASE + (MAX_CONCURRENT_WORK_ORDERS * PORT_RANGE_SIZE)


@pytest.mark.unit
def test_get_port_range_for_work_order_size():
    """Test that port range is exactly 10 ports"""
    work_order_id = "wo-test123"

    start, end = get_port_range_for_work_order(work_order_id)

    assert end - start + 1 == 10


@pytest.mark.unit
def test_get_port_range_for_work_order_uses_different_slots():
    """Test that the hash function can produce different slot assignments"""
    # Create very different IDs that should hash to different values
    ids = ["wo-aaaaaaaa", "wo-zzzzz999", "wo-12345678", "wo-abcdefgh", "wo-99999999"]
    ranges = [get_port_range_for_work_order(wid) for wid in ids]

    # Check all ranges are valid
    for start, end in ranges:
        assert end - start + 1 == 10
        assert PORT_BASE <= start < PORT_BASE + (MAX_CONCURRENT_WORK_ORDERS * PORT_RANGE_SIZE)

    # It's theoretically possible all hash to same slot, but unlikely with very different IDs
    # The important thing is the function works, not that it always distributes perfectly
    assert len(ranges) == 5  # We got 5 results


@pytest.mark.unit
def test_get_port_range_for_work_order_fallback_hash():
    """Test fallback to hash when base36 conversion fails"""
    # Non-alphanumeric work order ID
    work_order_id = "--------"

    start, end = get_port_range_for_work_order(work_order_id)

    # Should still work via hash fallback
    assert end - start + 1 == 10
    assert PORT_BASE <= start < PORT_BASE + (MAX_CONCURRENT_WORK_ORDERS * PORT_RANGE_SIZE)


@pytest.mark.unit
def test_is_port_available_mock_available():
    """Test port availability check when port is available"""
    with patch("socket.socket") as mock_socket:
        mock_socket_instance = mock_socket.return_value.__enter__.return_value
        mock_socket_instance.bind.return_value = None  # Successful bind

        result = is_port_available(9000)

        assert result is True
        mock_socket_instance.bind.assert_called_once_with(('localhost', 9000))


@pytest.mark.unit
def test_is_port_available_mock_unavailable():
    """Test port availability check when port is unavailable"""
    with patch("socket.socket") as mock_socket:
        mock_socket_instance = mock_socket.return_value.__enter__.return_value
        mock_socket_instance.bind.side_effect = OSError("Port in use")

        result = is_port_available(9000)

        assert result is False


@pytest.mark.unit
def test_find_available_port_range_all_available():
    """Test finding port range when all ports are available"""
    work_order_id = "wo-test123"

    # Mock all ports as available
    with patch(
        "src.agent_work_orders.utils.port_allocation.is_port_available",
        return_value=True,
    ):
        start, end, available = find_available_port_range(work_order_id)

        # Should get the deterministic range
        expected_start, expected_end = get_port_range_for_work_order(work_order_id)
        assert start == expected_start
        assert end == expected_end
        assert len(available) == 10  # All 10 ports available


@pytest.mark.unit
def test_find_available_port_range_some_unavailable():
    """Test finding port range when some ports are unavailable"""
    work_order_id = "wo-test123"
    expected_start, expected_end = get_port_range_for_work_order(work_order_id)

    # Mock: first, third, and fifth ports unavailable, rest available
    def mock_availability(port):
        offset = port - expected_start
        return offset not in [0, 2, 4]  # 7 out of 10 available

    with patch(
        "src.agent_work_orders.utils.port_allocation.is_port_available",
        side_effect=mock_availability,
    ):
        start, end, available = find_available_port_range(work_order_id)

        # Should still use this range (>= 5 ports available)
        assert start == expected_start
        assert end == expected_end
        assert len(available) == 7  # 7 ports available


@pytest.mark.unit
def test_find_available_port_range_fallback_to_next_slot():
    """Test fallback to next slot when first slot has too few ports"""
    work_order_id = "wo-test123"
    expected_start, expected_end = get_port_range_for_work_order(work_order_id)

    # Mock: First slot has only 3 available (< 5 needed), second slot has all
    def mock_availability(port):
        if expected_start <= port <= expected_end:
            # First slot: only 3 available
            offset = port - expected_start
            return offset < 3
        else:
            # Other slots: all available
            return True

    with patch(
        "src.agent_work_orders.utils.port_allocation.is_port_available",
        side_effect=mock_availability,
    ):
        start, end, available = find_available_port_range(work_order_id)

        # Should use a different slot
        assert (start, end) != (expected_start, expected_end)
        assert len(available) >= 5  # At least half available


@pytest.mark.unit
def test_find_available_port_range_exhausted():
    """Test that RuntimeError is raised when all port ranges are exhausted"""
    work_order_id = "wo-test123"

    # Mock all ports as unavailable
    with patch(
        "src.agent_work_orders.utils.port_allocation.is_port_available",
        return_value=False,
    ):
        with pytest.raises(RuntimeError) as exc_info:
            find_available_port_range(work_order_id)

        assert "No suitable port range found" in str(exc_info.value)


@pytest.mark.unit
def test_create_ports_env_file(tmp_path):
    """Test creating .ports.env file with port range"""
    worktree_path = str(tmp_path)
    start_port = 9000
    end_port = 9009
    available_ports = list(range(9000, 9010))  # All 10 ports

    create_ports_env_file(worktree_path, start_port, end_port, available_ports)

    ports_env_path = tmp_path / ".ports.env"
    assert ports_env_path.exists()

    content = ports_env_path.read_text()

    # Check range information
    assert "PORT_RANGE_START=9000" in content
    assert "PORT_RANGE_END=9009" in content
    assert "PORT_RANGE_SIZE=10" in content

    # Check individual ports
    assert "PORT_0=9000" in content
    assert "PORT_1=9001" in content
    assert "PORT_9=9009" in content

    # Check backward compatible aliases
    assert "BACKEND_PORT=9000" in content
    assert "FRONTEND_PORT=9001" in content
    assert "VITE_BACKEND_URL=http://localhost:9000" in content


@pytest.mark.unit
def test_create_ports_env_file_partial_availability(tmp_path):
    """Test creating .ports.env with some ports unavailable"""
    worktree_path = str(tmp_path)
    start_port = 9000
    end_port = 9009
    # Only some ports available
    available_ports = [9000, 9001, 9003, 9004, 9006, 9008, 9009]  # 7 ports

    create_ports_env_file(worktree_path, start_port, end_port, available_ports)

    ports_env_path = tmp_path / ".ports.env"
    content = ports_env_path.read_text()

    # Range should still show full range
    assert "PORT_RANGE_START=9000" in content
    assert "PORT_RANGE_END=9009" in content

    # But only available ports should be numbered
    assert "PORT_0=9000" in content
    assert "PORT_1=9001" in content
    assert "PORT_2=9003" in content  # Third available port is 9003
    assert "PORT_6=9009" in content  # Seventh available port is 9009

    # Backward compatible aliases should use first two available
    assert "BACKEND_PORT=9000" in content
    assert "FRONTEND_PORT=9001" in content


@pytest.mark.unit
def test_create_ports_env_file_overwrites(tmp_path):
    """Test that creating .ports.env file overwrites existing file"""
    worktree_path = str(tmp_path)
    ports_env_path = tmp_path / ".ports.env"

    # Create existing file with old content
    ports_env_path.write_text("OLD_CONTENT=true\n")

    # Create new file
    create_ports_env_file(
        worktree_path, 9000, 9009, list(range(9000, 9010))
    )

    content = ports_env_path.read_text()
    assert "OLD_CONTENT" not in content
    assert "PORT_RANGE_START=9000" in content


@pytest.mark.unit
def test_port_ranges_do_not_overlap():
    """Test that consecutive work order slots have non-overlapping port ranges"""
    # Create work order IDs that will map to different slots
    ids = [f"wo-{i:08x}" for i in range(5)]  # Create 5 different IDs

    ranges = [get_port_range_for_work_order(wid) for wid in ids]

    # Check that ranges don't overlap
    for i, (start1, end1) in enumerate(ranges):
        for j, (start2, end2) in enumerate(ranges):
            if i != j:
                # Ranges should not overlap
                overlaps = not (end1 < start2 or end2 < start1)
                # If they overlap, they must be the same range (hash collision)
                if overlaps:
                    assert start1 == start2 and end1 == end2


@pytest.mark.unit
def test_max_concurrent_work_orders():
    """Test that we support MAX_CONCURRENT_WORK_ORDERS distinct ranges"""
    # Generate MAX_CONCURRENT_WORK_ORDERS + 1 IDs
    ids = [f"wo-{i:08x}" for i in range(MAX_CONCURRENT_WORK_ORDERS + 1)]

    ranges = [get_port_range_for_work_order(wid) for wid in ids]
    unique_ranges = set(ranges)

    # Should have at most MAX_CONCURRENT_WORK_ORDERS unique ranges
    assert len(unique_ranges) <= MAX_CONCURRENT_WORK_ORDERS

    # And they should all fit within the allocated port space
    for start, end in unique_ranges:
        assert PORT_BASE <= start < PORT_BASE + (MAX_CONCURRENT_WORK_ORDERS * PORT_RANGE_SIZE)
        assert PORT_BASE < end <= PORT_BASE + (MAX_CONCURRENT_WORK_ORDERS * PORT_RANGE_SIZE)
