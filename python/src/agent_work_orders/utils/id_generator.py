"""ID Generation Utilities

Generates unique identifiers for work orders and other entities.
"""

import secrets


def generate_work_order_id() -> str:
    """Generate a unique work order ID

    Format: wo-{random_hex}
    Example: wo-a3c2f1e4

    Returns:
        Unique work order ID string
    """
    return f"wo-{secrets.token_hex(4)}"


def generate_sandbox_identifier(agent_work_order_id: str) -> str:
    """Generate sandbox identifier from work order ID

    Args:
        agent_work_order_id: Work order ID

    Returns:
        Sandbox identifier
    """
    return f"sandbox-{agent_work_order_id}"
