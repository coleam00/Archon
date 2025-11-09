"""Port allocation utilities for isolated agent work order execution.

Provides deterministic port range allocation (10 ports per work order)
based on work order ID to enable parallel execution without port conflicts.

Architecture:
- Each work order gets a range of 10 consecutive ports
- Base port: 9000
- Total range: 9000-9199 (200 ports)
- Supports: 20 concurrent work orders
- Ports can be used flexibly (CLI tools use 0, microservices use multiple)
"""

import os
import socket

# Port allocation configuration
PORT_RANGE_SIZE = 10  # Each work order gets 10 ports
PORT_BASE = 9000  # Starting port
MAX_CONCURRENT_WORK_ORDERS = 20  # 200 ports / 10 = 20 concurrent


def get_port_range_for_work_order(work_order_id: str) -> tuple[int, int]:
    """Get port range for work order.

    Deterministically assigns a 10-port range based on work order ID.

    Args:
        work_order_id: The work order identifier

    Returns:
        Tuple of (start_port, end_port)

    Example:
        wo-abc123 -> (9000, 9009)  # 10 ports
        wo-def456 -> (9010, 9019)  # 10 ports
        wo-xyz789 -> (9020, 9029)  # 10 ports
    """
    # Convert work order ID to slot (0-19)
    try:
        # Take first 8 alphanumeric chars and convert from base 36
        id_chars = ''.join(c for c in work_order_id[:8] if c.isalnum())
        slot = int(id_chars, 36) % MAX_CONCURRENT_WORK_ORDERS
    except ValueError:
        # Fallback to simple hash if conversion fails
        slot = hash(work_order_id) % MAX_CONCURRENT_WORK_ORDERS

    start_port = PORT_BASE + (slot * PORT_RANGE_SIZE)
    end_port = start_port + PORT_RANGE_SIZE - 1

    return start_port, end_port


def is_port_available(port: int) -> bool:
    """Check if a port is available for binding.

    Args:
        port: Port number to check

    Returns:
        True if port is available, False otherwise
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            s.bind(('localhost', port))
            return True
    except OSError:
        return False


def find_available_port_range(
    work_order_id: str, max_attempts: int = MAX_CONCURRENT_WORK_ORDERS
) -> tuple[int, int, list[int]]:
    """Find available port range and check which ports are actually free.

    Args:
        work_order_id: The work order ID
        max_attempts: Maximum number of slot attempts (default 20)

    Returns:
        Tuple of (start_port, end_port, available_ports)
        available_ports is a list of ports in the range that are actually free

    Raises:
        RuntimeError: If no suitable port range found after max_attempts

    Example:
        >>> find_available_port_range("wo-abc123")
        (9000, 9009, [9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009])
    """
    start_port, end_port = get_port_range_for_work_order(work_order_id)
    base_slot = (start_port - PORT_BASE) // PORT_RANGE_SIZE

    # Try multiple slots if first one has conflicts
    for offset in range(max_attempts):
        slot = (base_slot + offset) % MAX_CONCURRENT_WORK_ORDERS
        current_start = PORT_BASE + (slot * PORT_RANGE_SIZE)
        current_end = current_start + PORT_RANGE_SIZE - 1

        # Check which ports in this range are available
        available = []
        for port in range(current_start, current_end + 1):
            if is_port_available(port):
                available.append(port)

        # If we have at least half the ports available, use this range
        # (allows for some port conflicts while still being usable)
        if len(available) >= PORT_RANGE_SIZE // 2:
            return current_start, current_end, available

    raise RuntimeError(
        f"No suitable port range found after {max_attempts} attempts. "
        f"Try stopping other services or wait for work orders to complete."
    )


def create_ports_env_file(
    worktree_path: str,
    start_port: int,
    end_port: int,
    available_ports: list[int]
) -> None:
    """Create .ports.env file in worktree with port range configuration.

    Args:
        worktree_path: Path to the worktree
        start_port: Start of port range
        end_port: End of port range
        available_ports: List of actually available ports in range

    Generated file format:
        # Port range information
        PORT_RANGE_START=9000
        PORT_RANGE_END=9009
        PORT_RANGE_SIZE=10

        # Individual ports (PORT_0, PORT_1, ...)
        PORT_0=9000
        PORT_1=9001
        ...
        PORT_9=9009

        # Convenience aliases (backward compatible)
        BACKEND_PORT=9000
        FRONTEND_PORT=9001
        VITE_BACKEND_URL=http://localhost:9000
    """
    ports_env_path = os.path.join(worktree_path, ".ports.env")

    with open(ports_env_path, "w") as f:
        # Header
        f.write("# Port range allocated to this work order\n")
        f.write("# Each work order gets 10 consecutive ports for flexibility\n")
        f.write("# CLI tools can ignore ports, microservices can use multiple\n\n")

        # Range information
        f.write(f"PORT_RANGE_START={start_port}\n")
        f.write(f"PORT_RANGE_END={end_port}\n")
        f.write(f"PORT_RANGE_SIZE={end_port - start_port + 1}\n\n")

        # Individual numbered ports for easy access
        f.write("# Individual ports (use PORT_0, PORT_1, etc.)\n")
        for i, port in enumerate(available_ports):
            f.write(f"PORT_{i}={port}\n")

        # Backward compatible aliases
        f.write("\n# Convenience aliases (backward compatible with old format)\n")
        if len(available_ports) >= 1:
            f.write(f"BACKEND_PORT={available_ports[0]}\n")
        if len(available_ports) >= 2:
            f.write(f"FRONTEND_PORT={available_ports[1]}\n")
            f.write(f"VITE_BACKEND_URL=http://localhost:{available_ports[0]}\n")


# Backward compatibility function (deprecated, but kept for migration)
def get_ports_for_work_order(work_order_id: str) -> tuple[int, int]:
    """DEPRECATED: Get backend and frontend ports.

    This function is kept for backward compatibility during migration.
    Use get_port_range_for_work_order() and find_available_port_range() instead.

    Args:
        work_order_id: The work order identifier

    Returns:
        Tuple of (backend_port, frontend_port)
    """
    start_port, end_port = get_port_range_for_work_order(work_order_id)
    # Return first two ports in range as backend/frontend
    return start_port, start_port + 1


# Backward compatibility function (deprecated, but kept for migration)
def find_next_available_ports(work_order_id: str, max_attempts: int = 20) -> tuple[int, int]:
    """DEPRECATED: Find available backend and frontend ports.

    This function is kept for backward compatibility during migration.
    Use find_available_port_range() instead.

    Args:
        work_order_id: The work order ID
        max_attempts: Maximum number of attempts (default 20)

    Returns:
        Tuple of (backend_port, frontend_port)

    Raises:
        RuntimeError: If no available ports found
    """
    start_port, end_port, available_ports = find_available_port_range(
        work_order_id, max_attempts
    )

    if len(available_ports) < 2:
        raise RuntimeError(
            f"Need at least 2 ports, only {len(available_ports)} available in range"
        )

    return available_ports[0], available_ports[1]
