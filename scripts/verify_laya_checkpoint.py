#!/usr/bin/env python3
"""Verify the pinned Laya checkpoint against the exporter model, using local files only."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, MutableMapping


VERIFICATION_MARKER_PATH = (
    Path(__file__).resolve().parents[1]
    / "packages/core/src/orchestrator/laya-checkpoint-verification.json"
)
with VERIFICATION_MARKER_PATH.open("r", encoding="utf-8") as marker_file:
    CHECKPOINT_VERIFICATION = json.load(marker_file)
if not isinstance(CHECKPOINT_VERIFICATION, dict) or set(CHECKPOINT_VERIFICATION) != {
    "schemaVersion",
    "method",
    "tensorCount",
    "sourceDtype",
    "loadDtype",
    "exportDtype",
    "loadStrict",
}:
    raise RuntimeError("the shared checkpoint verification marker has an invalid shape")
if (
    type(CHECKPOINT_VERIFICATION["schemaVersion"]) is not int
    or CHECKPOINT_VERIFICATION["schemaVersion"] != 1
    or not isinstance(CHECKPOINT_VERIFICATION["method"], str)
    or not CHECKPOINT_VERIFICATION["method"]
    or type(CHECKPOINT_VERIFICATION["tensorCount"]) is not int
    or CHECKPOINT_VERIFICATION["tensorCount"] <= 0
    or any(
        not isinstance(CHECKPOINT_VERIFICATION[key], str)
        for key in ("sourceDtype", "loadDtype", "exportDtype")
    )
    or CHECKPOINT_VERIFICATION["loadStrict"] is not True
):
    raise RuntimeError("the shared checkpoint verification marker has invalid values")
EXPECTED_TENSOR_COUNT = CHECKPOINT_VERIFICATION["tensorCount"]


class CheckpointVerificationError(ValueError):
    """The checkpoint does not exactly cover the pinned model state."""


def verify_and_load_state_dict(
    model: Any,
    checkpoint_state: MutableMapping[str, Any],
    *,
    float16_dtype: Any,
    float32_dtype: Any,
) -> dict[str, Any]:
    """Check all tensors, cast the known F16 checkpoint to FP32, and strictly load it."""
    expected_state = model.state_dict()
    expected_keys = set(expected_state)
    checkpoint_keys = set(checkpoint_state)
    if len(checkpoint_state) != EXPECTED_TENSOR_COUNT:
        raise CheckpointVerificationError(
            f"expected {EXPECTED_TENSOR_COUNT} checkpoint tensors, found {len(checkpoint_state)}"
        )
    if expected_keys != checkpoint_keys:
        missing = sorted(expected_keys - checkpoint_keys)
        unexpected = sorted(checkpoint_keys - expected_keys)
        raise CheckpointVerificationError(
            "checkpoint tensor keys do not exactly match the model "
            f"(missing={len(missing)}, unexpected={len(unexpected)})"
        )

    for name, expected_tensor in expected_state.items():
        checkpoint_tensor = checkpoint_state[name]
        if tuple(checkpoint_tensor.shape) != tuple(expected_tensor.shape):
            raise CheckpointVerificationError(
                f"checkpoint tensor shape mismatch: {name}"
            )
        if checkpoint_tensor.dtype != float16_dtype:
            raise CheckpointVerificationError(
                f"checkpoint tensor dtype mismatch for {name}: expected float16"
            )
        if expected_tensor.dtype != float32_dtype:
            raise CheckpointVerificationError(
                f"export model tensor dtype mismatch for {name}: expected float32"
            )

    # Replace the private Safetensors mapping in place to avoid retaining both the
    # F16 checkpoint and a second full-size FP32 state dict during preflight.
    for name, expected_tensor in expected_state.items():
        checkpoint_tensor = checkpoint_state[name]
        checkpoint_state[name] = checkpoint_tensor.to(dtype=expected_tensor.dtype)
        del checkpoint_tensor

    incompatible = model.load_state_dict(checkpoint_state, strict=True)
    if getattr(incompatible, "missing_keys", ()) or getattr(
        incompatible, "unexpected_keys", ()
    ):
        raise CheckpointVerificationError(
            "strict checkpoint load reported incompatible tensor keys"
        )

    model.float().eval()
    return dict(CHECKPOINT_VERIFICATION)


def verify_local_checkpoint(model_dir: Path, exporter_dir: Path) -> dict[str, Any]:
    """Build the pinned architecture and verify its locally staged Safetensors checkpoint."""
    for variable in (
        "HF_TOKEN",
        "HUGGINGFACE_HUB_TOKEN",
        "HUGGING_FACE_HUB_TOKEN",
        "HF_ENDPOINT",
    ):
        os.environ.pop(variable, None)
    os.environ.update(
        {
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_DATASETS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
        }
    )
    if not model_dir.is_absolute() or not exporter_dir.is_absolute():
        raise CheckpointVerificationError(
            "checkpoint and exporter paths must be absolute"
        )
    if not model_dir.is_dir() or model_dir.is_symlink():
        raise CheckpointVerificationError(
            "checkpoint path must be a real local directory"
        )
    if not exporter_dir.is_dir() or exporter_dir.is_symlink():
        raise CheckpointVerificationError(
            "exporter path must be a real local directory"
        )

    checkpoint_file = model_dir / "model.safetensors"
    config_file = model_dir / "rl_agent_config.json"
    encoder_dir = model_dir / "encoder"
    if any(
        not path.is_file() or path.is_symlink()
        for path in (checkpoint_file, config_file)
    ):
        raise CheckpointVerificationError(
            "local checkpoint is missing a required regular file"
        )
    if not encoder_dir.is_dir() or encoder_dir.is_symlink():
        raise CheckpointVerificationError(
            "local checkpoint encoder config directory is missing"
        )

    # Import only from the pinned checkout and construct from its verified local config.
    sys.path.insert(0, str(exporter_dir))
    import torch
    from safetensors.torch import load_file
    from laya.common import build_model

    try:
        from transformers.initialization import no_init_weights
    except ImportError:  # Transformers 4.x
        from transformers.modeling_utils import no_init_weights

    with config_file.open("r", encoding="utf-8") as source:
        config = json.load(source)
    with no_init_weights():
        model = build_model(config, encoder_dir=str(encoder_dir), pretrained=False)
    weights = load_file(str(checkpoint_file), device="cpu")
    return verify_and_load_state_dict(
        model,
        weights,
        float16_dtype=torch.float16,
        float32_dtype=torch.float32,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--exporter-dir", required=True, type=Path)
    parser.add_argument("--report-file", required=True, type=Path)
    args = parser.parse_args()
    if (
        not args.report_file.is_absolute()
        or args.report_file.exists()
        or args.report_file.is_symlink()
    ):
        raise CheckpointVerificationError(
            "verification report must be a new absolute file path"
        )

    verification = verify_local_checkpoint(args.model_dir, args.exporter_dir)
    args.report_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with args.report_file.open("x", encoding="utf-8") as report:
        json.dump(verification, report, sort_keys=True)
        report.write("\n")
        report.flush()
        os.fsync(report.fileno())
    print(
        "Checkpoint verified: 206 F16 tensors matched exact model keys and shapes, "
        "were explicitly converted to FP32, and loaded with strict=True."
    )


if __name__ == "__main__":
    main()
