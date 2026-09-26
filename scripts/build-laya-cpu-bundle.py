#!/usr/bin/env python3
"""Build an unapproved, local ONNX bundle from the pinned ModelScope source.

Run this only in an isolated exporter environment with the pinned official Laya
checkout. Export verification is always enabled; this script never accepts a
checkpoint repository name or a no-verify switch. The resulting manifest stays
unapproved until product evaluation and human artifact review are complete.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterator

from verify_laya_checkpoint import CHECKPOINT_VERIFICATION


MODEL_ID = "convaiinnovations/laya"
MODEL_SOURCE = "https://www.modelscope.cn/models/convaiinnovations/laya/typed-decisions"
MODEL_REVISION = "69f17eefb6910e69dbb031dcc3c8e3f556cff267"
MODEL_LICENSE = "Apache-2.0"
EXPORTER_REPOSITORY = "NandhaKishorM/laya"
EXPORTER_COMMIT = "23a17522aa4942da6cce53a995a275760320b691"
RUNTIME_COMMIT = "4066d5d5fbf08b66c6757ddeedbd797bd7655bc0"
MANIFEST_NAME = "laya-bundle-manifest.json"
MAX_MANIFEST_BYTES = 64 * 1024
MAX_ENCODER_BYTES = 2 * 1024**3
MAX_HEAD_BYTES = 512 * 1024**2
MAX_TOTAL_BYTES = 4 * 1024**3

SOURCE_FILES = (
    ("model.safetensors", 842_609_220, "4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e", True),
    ("tokenizer/tokenizer.json", 3_583_228, "6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30", True),
    ("rl_agent_config.json", 847, "ebf0cd524d92342a6be5e48e9fca3d7c2babfb5a56ccd79d2171ef5d8c7f7be8", False),
    ("encoder/config.json", 2_084, "5268d24ad3b77c8151de5dcb0762ba4391619aad9ab0bda33e36fb083cfeae6d", False),
    ("tokenizer/tokenizer_config.json", 337, "08d4cf3ac4dca381759441b85b91a6d40e688471dcd33d15d6649eb0a9a854d1", False),
)
RUNTIME_FILES = ("encoder.onnx", "head.onnx", "rl_agent_config.json", "tokenizer.json")
EXPORT_FILES = {
    "encoder.onnx",
    "encoder.onnx.data",
    "head.onnx",
    "head.onnx.data",
    "rl_agent_config.json",
    "tokenizer.json",
}
EXPORT_FILE_LIMITS = {
    "encoder.onnx": MAX_ENCODER_BYTES,
    "encoder.onnx.data": MAX_ENCODER_BYTES,
    "head.onnx": MAX_HEAD_BYTES,
    "head.onnx.data": MAX_HEAD_BYTES,
    "rl_agent_config.json": 1024 * 1024,
    "tokenizer.json": 64 * 1024 * 1024,
}


class BuildError(Exception):
    """Expected fail-closed artifact build error."""


def fail(message: str) -> None:
    raise BuildError(message)


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(file_path: Path) -> Any:
    try:
        with file_path.open("r", encoding="utf-8") as source:
            return json.load(source, object_pairs_hook=reject_duplicate_keys)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise BuildError(f"invalid JSON file: {file_path.name}") from error


def inventory_tree(root: Path) -> tuple[set[str], set[str]]:
    files: set[str] = set()
    directories: set[str] = set()
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        current_path = Path(current)
        for name in directory_names:
            entry = current_path / name
            info = entry.lstat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                fail(f"unexpected symlink or non-directory: {entry.relative_to(root)}")
            directories.add(entry.relative_to(root).as_posix())
        for name in file_names:
            entry = current_path / name
            info = entry.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
                fail(f"unexpected link or non-regular file: {entry.relative_to(root)}")
            files.add(entry.relative_to(root).as_posix())
    return files, directories


def digest_file(file_path: Path, limit: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with file_path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            size += len(chunk)
            if size > limit:
                fail(f"file exceeds its size limit: {file_path.name}")
            digest.update(chunk)
    return digest.hexdigest(), size


def require_regular_file(root: Path, relative: str) -> Path:
    file_path = root / relative
    try:
        info = file_path.lstat()
    except FileNotFoundError as error:
        raise BuildError(f"required file is missing: {relative}") from error
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        fail(f"expected a regular, unlinked file: {relative}")
    return file_path


def expected_source_manifest() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "source": f"https://www.modelscope.cn/models/{MODEL_ID}",
        "modelId": MODEL_ID,
        "revision": MODEL_REVISION,
        "license": MODEL_LICENSE,
        "files": [
            {
                "repositoryPath": f"typed-decisions/{relative}",
                "stagedPath": relative,
                "sizeBytes": size,
                "sha256": digest,
                "lfs": lfs,
            }
            for relative, size, digest, lfs in SOURCE_FILES
        ],
        "note": "Source checkpoint intake only; this is not an Archon runtime bundle.",
    }


def verify_source(source_root: Path) -> None:
    expected_files = {"source-manifest.json", *(item[0] for item in SOURCE_FILES)}
    files, directories = inventory_tree(source_root)
    if files != expected_files or directories != {"encoder", "tokenizer"}:
        fail("staged source tree contains missing or unexpected files")
    manifest_path = require_regular_file(source_root, "source-manifest.json")
    if manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
        fail("staged source manifest exceeds its size limit")
    if read_json(manifest_path) != expected_source_manifest():
        fail("staged source manifest does not match the pinned ModelScope revision")
    for relative, expected_size, expected_digest, _lfs in SOURCE_FILES:
        file_path = require_regular_file(source_root, relative)
        actual_digest, actual_size = digest_file(file_path, expected_size)
        if (actual_size, actual_digest) != (expected_size, expected_digest):
            fail(f"staged source hash or size mismatch: {relative}")


def copy_verified_source(source_root: Path, destination_root: Path) -> None:
    destination_root.mkdir(mode=0o700)
    for directory in ("encoder", "tokenizer"):
        (destination_root / directory).mkdir(mode=0o700)
    for relative, expected_size, expected_digest, _lfs in SOURCE_FILES:
        source_path = require_regular_file(source_root, relative)
        destination_path = destination_root / relative
        source_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            source_fd = os.open(source_path, source_flags)
        except OSError as error:
            raise BuildError(f"could not open pinned source file: {relative}") from error
        try:
            source_info = os.fstat(source_fd)
            if not stat.S_ISREG(source_info.st_mode) or source_info.st_nlink != 1:
                fail(f"pinned source changed while being copied: {relative}")
            digest = hashlib.sha256()
            copied_size = 0
            with os.fdopen(source_fd, "rb", closefd=False) as source, destination_path.open("xb") as output:
                while chunk := source.read(8 * 1024 * 1024):
                    copied_size += len(chunk)
                    if copied_size > expected_size:
                        fail(f"pinned source grew while being copied: {relative}")
                    digest.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            if (copied_size, digest.hexdigest()) != (expected_size, expected_digest):
                fail(f"pinned source changed while being copied: {relative}")
            os.chmod(destination_path, 0o400)
        finally:
            os.close(source_fd)
    manifest_path = destination_root / "source-manifest.json"
    with manifest_path.open("x", encoding="utf-8") as output:
        json.dump(expected_source_manifest(), output, indent=2)
        output.write("\n")
    os.chmod(manifest_path, 0o400)


def run_git(checkout: Path, *args: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(checkout), *args],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise BuildError("could not verify the pinned Laya exporter checkout") from error
    return result.stdout.strip()


def verify_exporter(checkout: Path) -> Path:
    if not checkout.is_absolute() or not checkout.is_dir() or checkout.is_symlink():
        fail("exporter checkout must be an absolute, real directory")
    remote = run_git(checkout, "remote", "get-url", "origin")
    if not re.fullmatch(
        r"(?:https://github\.com/NandhaKishorM/laya(?:\.git)?|git@github\.com:NandhaKishorM/laya\.git)",
        remote,
    ):
        fail("exporter origin is not the pinned official Laya repository")
    if run_git(checkout, "rev-parse", "HEAD") != EXPORTER_COMMIT:
        fail("exporter checkout is not at the pinned commit")
    if run_git(checkout, "status", "--porcelain", "--untracked-files=all"):
        fail("exporter checkout must be clean")
    exporter = checkout / "laya-ts" / "scripts" / "export_onnx.py"
    if not exporter.is_file() or exporter.is_symlink():
        fail("pinned checkout is missing the ONNX exporter")
    return exporter


def iter_graph_tensors(graph: Any) -> Iterator[Any]:
    yield from graph.initializer
    for sparse in graph.sparse_initializer:
        yield sparse.values
        yield sparse.indices
    for node in graph.node:
        for attribute in node.attribute:
            if attribute.HasField("t"):
                yield attribute.t
            yield from attribute.tensors
            if attribute.HasField("sparse_tensor"):
                yield attribute.sparse_tensor.values
                yield attribute.sparse_tensor.indices
            for sparse in attribute.sparse_tensors:
                yield sparse.values
                yield sparse.indices
            if attribute.HasField("g"):
                yield from iter_graph_tensors(attribute.g)
            for nested_graph in attribute.graphs:
                yield from iter_graph_tensors(nested_graph)


def validate_external_locations(model: Any, export_root: Path, expected_sidecar: str) -> None:
    sidecar = require_regular_file(export_root, expected_sidecar)
    sidecar_size = sidecar.stat().st_size
    if sidecar_size <= 0 or sidecar_size > EXPORT_FILE_LIMITS[expected_sidecar]:
        fail(f"ONNX external tensor file is empty or too large: {expected_sidecar}")
    found_external = False
    for tensor in iter_graph_tensors(model.graph):
        if not tensor.external_data:
            continue
        found_external = True
        values = {entry.key: entry.value for entry in tensor.external_data}
        location = values.get("location", "")
        if location != expected_sidecar or Path(location).name != location:
            fail(f"ONNX external tensor references an unexpected file in {expected_sidecar}")
        if len(values) != len(tensor.external_data):
            fail(f"ONNX external tensor has duplicate metadata in {expected_sidecar}")
        offset = int(values.get("offset", "0"))
        length_value = values.get("length")
        length = int(length_value) if length_value is not None else sidecar_size - offset
        if offset < 0 or length < 0 or offset + length > sidecar_size:
            fail(f"ONNX external tensor range exceeds {expected_sidecar}")
    if not found_external:
        fail(f"expected external tensor data in {expected_sidecar}")


def inline_external_data(model_path: Path, sidecar_name: str, export_root: Path, destination: Path) -> None:
    try:
        import onnx
        from onnx.external_data_helper import (
            convert_model_from_external_data,
            load_external_data_for_model,
        )
    except ImportError as error:
        raise BuildError("the isolated exporter environment must include the onnx package") from error

    try:
        model = onnx.load_model(str(model_path), load_external_data=False)
        validate_external_locations(model, export_root, sidecar_name)
        load_external_data_for_model(model, str(export_root))
        convert_model_from_external_data(model)
        for graph in [model.graph]:
            if any(tensor.external_data for tensor in iter_graph_tensors(graph)):
                fail(f"ONNX external data was not inlined: {model_path.name}")
        onnx.checker.check_model(model)
        onnx.save_model(model, str(destination), save_as_external_data=False)
    except BuildError:
        raise
    except Exception as error:
        raise BuildError(f"could not inline and validate {model_path.name}") from error


def ensure_disjoint(paths: list[Path]) -> None:
    for index, left in enumerate(paths):
        for right in paths[index + 1 :]:
            if left == right or left in right.parents or right in left.parents:
                fail("source, exporter, and output paths must not overlap")


def build(args: argparse.Namespace) -> None:
    source_root = Path(args.checkpoint_dir)
    exporter_root = Path(args.exporter_dir)
    output_dir = Path(args.output_dir)
    python_executable = Path(args.python)
    for label, value in (
        ("checkpoint directory", source_root),
        ("exporter directory", exporter_root),
        ("output directory", output_dir),
        ("python executable", python_executable),
    ):
        if not value.is_absolute():
            fail(f"{label} must be an absolute path")
    for label, candidate in (("checkpoint directory", source_root), ("exporter directory", exporter_root)):
        try:
            info = candidate.lstat()
        except FileNotFoundError as error:
            raise BuildError(f"{label} does not exist") from error
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            fail(f"{label} must be a real directory, not a symlink")
    source_root = source_root.resolve(strict=True)
    exporter_root = exporter_root.resolve(strict=True)
    if not python_executable.is_file():
        fail("the exporter Python executable does not exist")
    python_executable = python_executable.resolve(strict=True)
    if not output_dir.parent.is_dir() or output_dir.parent.is_symlink():
        fail("output parent must be an existing, real directory")
    output_dir = output_dir.parent.resolve(strict=True) / output_dir.name
    ensure_disjoint([source_root, exporter_root, output_dir])
    if output_dir.exists() or output_dir.is_symlink():
        fail("refusing to overwrite an existing output directory")

    verify_source(source_root)
    exporter_script = verify_exporter(exporter_root)
    lock_path = output_dir.with_name(f".{output_dir.name}.lock")
    lock_fd: int | None = None
    try:
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise BuildError("an output build lock already exists; inspect it before removal") from error

    temporary_root: Path | None = None
    try:
        if output_dir.exists() or output_dir.is_symlink():
            fail("refusing to overwrite an output directory created during build setup")
        temporary_root = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.tmp-", dir=output_dir.parent))
        os.chmod(temporary_root, 0o700)
        source_snapshot = temporary_root / "source"
        copy_verified_source(source_root, source_snapshot)
        verify_source(source_snapshot)
        export_root = temporary_root / "export"
        export_root.mkdir(mode=0o700)

        environment = os.environ.copy()
        for variable in (
            "HF_TOKEN",
            "HUGGINGFACE_HUB_TOKEN",
            "HUGGING_FACE_HUB_TOKEN",
            "HF_ENDPOINT",
        ):
            environment.pop(variable, None)
        environment.update(
            {
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                "HF_DATASETS_OFFLINE": "1",
                "HF_HUB_DISABLE_TELEMETRY": "1",
                "TOKENIZERS_PARALLELISM": "false",
            }
        )
        verification_report = temporary_root / "checkpoint-verification.json"
        subprocess.run(
            [
                str(python_executable),
                str(Path(__file__).with_name("verify_laya_checkpoint.py")),
                "--model-dir",
                str(source_snapshot),
                "--exporter-dir",
                str(exporter_root),
                "--report-file",
                str(verification_report),
            ],
            cwd=exporter_root,
            env=environment,
            check=True,
        )
        checkpoint_verification = read_json(verification_report)
        if checkpoint_verification != CHECKPOINT_VERIFICATION:
            fail(
                "checkpoint preflight did not produce the required strict-verification marker"
            )

        subprocess.run(
            [
                str(python_executable),
                str(exporter_script),
                "--model-dir",
                str(source_snapshot),
                "--out-dir",
                str(export_root),
            ],
            cwd=exporter_root,
            env=environment,
            check=True,
        )
        if run_git(exporter_root, "rev-parse", "HEAD") != EXPORTER_COMMIT or run_git(
            exporter_root, "status", "--porcelain", "--untracked-files=all"
        ):
            fail("exporter checkout changed during conversion")

        files, directories = inventory_tree(export_root)
        if files != EXPORT_FILES or directories:
            fail("verified exporter produced missing or unexpected files")
        export_size = 0
        for file_name, file_limit in EXPORT_FILE_LIMITS.items():
            file_size = require_regular_file(export_root, file_name).stat().st_size
            if file_size <= 0 or file_size > file_limit:
                fail(f"verified exporter output is empty or too large: {file_name}")
            export_size += file_size
        if export_size > MAX_TOTAL_BYTES:
            fail("verified exporter output exceeds the aggregate size limit")
        for exported, source_relative in (
            ("tokenizer.json", "tokenizer/tokenizer.json"),
            ("rl_agent_config.json", "rl_agent_config.json"),
        ):
            if digest_file(require_regular_file(export_root, exported), MAX_TOTAL_BYTES) != digest_file(
                require_regular_file(source_snapshot, source_relative), MAX_TOTAL_BYTES
            ):
                fail(f"exported source artifact changed: {exported}")

        bundle_root = temporary_root / "bundle"
        bundle_root.mkdir(mode=0o700)
        inline_external_data(
            require_regular_file(export_root, "encoder.onnx"),
            "encoder.onnx.data",
            export_root,
            bundle_root / "encoder.onnx",
        )
        inline_external_data(
            require_regular_file(export_root, "head.onnx"),
            "head.onnx.data",
            export_root,
            bundle_root / "head.onnx",
        )
        for file_name, source_relative in (
            ("rl_agent_config.json", "rl_agent_config.json"),
            ("tokenizer.json", "tokenizer/tokenizer.json"),
        ):
            shutil.copyfile(require_regular_file(source_snapshot, source_relative), bundle_root / file_name)

        file_manifest: dict[str, dict[str, Any]] = {}
        total_size = 0
        file_limits = {
            "encoder.onnx": MAX_ENCODER_BYTES,
            "head.onnx": MAX_HEAD_BYTES,
            "rl_agent_config.json": 1024 * 1024,
            "tokenizer.json": 64 * 1024 * 1024,
        }
        for file_name in RUNTIME_FILES:
            file_path = require_regular_file(bundle_root, file_name)
            digest, size = digest_file(file_path, file_limits[file_name])
            total_size += size
            file_manifest[file_name] = {"sha256": digest, "sizeBytes": size}
            os.chmod(file_path, 0o600)
        if total_size > MAX_TOTAL_BYTES:
            fail("inlined runtime bundle exceeds the aggregate size limit")

        manifest = {
            "schemaVersion": 1,
            "runtimeCommit": RUNTIME_COMMIT,
            "exporter": {"repository": EXPORTER_REPOSITORY, "commit": EXPORTER_COMMIT},
            "model": {
                "source": MODEL_SOURCE,
                "revision": MODEL_REVISION,
                "license": MODEL_LICENSE,
                "approvalStatus": "unapproved",
                "approvalReference": "",
            },
            "checkpointVerification": checkpoint_verification,
            "files": file_manifest,
        }
        manifest_path = bundle_root / MANIFEST_NAME
        with manifest_path.open("x", encoding="utf-8") as output:
            json.dump(manifest, output, indent=2, sort_keys=True)
            output.write("\n")
        os.chmod(manifest_path, 0o600)
        manifest_digest, manifest_size = digest_file(manifest_path, MAX_MANIFEST_BYTES)
        if total_size + manifest_size > MAX_TOTAL_BYTES:
            fail("runtime bundle manifest exceeds the aggregate bundle size limit")

        published_files, published_directories = inventory_tree(bundle_root)
        if published_files != {*RUNTIME_FILES, MANIFEST_NAME} or published_directories:
            fail("candidate bundle contains unexpected files")
        if output_dir.exists() or output_dir.is_symlink():
            fail("refusing to publish over an output directory created during the build")
        os.rename(bundle_root, output_dir)
        os.close(lock_fd)
        lock_fd = None
        lock_path.unlink()
        print(f"Unapproved local CPU bundle created at {output_dir}")
        print(f"Manifest SHA-256: {manifest_digest}")
        print("The Archon resolver rejects this bundle until a reviewed approval reference is recorded.")
    except BaseException:
        if lock_fd is not None:
            os.close(lock_fd)
        lock_path.unlink(missing_ok=True)
        raise
    finally:
        if temporary_root is not None:
            shutil.rmtree(temporary_root, ignore_errors=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint-dir", required=True, help="Pinned ModelScope staging directory")
    parser.add_argument("--exporter-dir", required=True, help="Clean official Laya checkout at the pinned commit")
    parser.add_argument("--output-dir", required=True, help="New path for the unapproved CPU bundle")
    parser.add_argument("--python", required=True, help="Absolute Python executable in the isolated exporter environment")
    return parser.parse_args()


if __name__ == "__main__":
    try:
        build(parse_args())
    except (BuildError, OSError, subprocess.CalledProcessError) as error:
        print(f"bundle build failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
