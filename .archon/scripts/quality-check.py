"""Technical QC on the finished video, plus frame stills for visual review.

This node judges only what is objectively measurable — geometry, sync, audio
levels, dead frames. Whether the video is any *good* is the vision node's job;
mixing the two would let a model talk us out of a real defect.

Reads  : video.mp4, words.json
Writes : quality.json, frames/frame-N.jpg
Exits non-zero on defects that make the video unusable.
"""

from __future__ import annotations

import json
import re
import subprocess

from _common import log, probe, read_json, work_dir, write_json

EXPECT_W, EXPECT_H = 1080, 1920
DURATION_TOLERANCE = 1.0   # seconds of drift from the narration we accept
MIN_MEAN_DB = -32.0        # quieter than this and the voice is inaudible
MAX_PEAK_DB = -0.5         # louder than this and we are clipping
N_FRAMES = 6


def ffmpeg_stderr(args: list[str]) -> str:
    return subprocess.run(
        ["ffmpeg", "-hide_banner", *args], capture_output=True, text=True
    ).stderr


def main() -> None:
    wd = work_dir()
    video = wd / "video.mp4"
    if not video.exists():
        raise SystemExit("video.mp4 was not produced")

    words = read_json("words.json")
    meta = probe(video)
    vstream = next((s for s in meta["streams"] if s["codec_type"] == "video"), None)
    astream = next((s for s in meta["streams"] if s["codec_type"] == "audio"), None)

    checks: list[dict] = []

    def check(name: str, ok: bool, detail: str, fatal: bool = False) -> None:
        checks.append({"check": name, "ok": ok, "detail": detail, "fatal": fatal})
        log(f"  [{'ok ' if ok else 'FAIL'}] {name}: {detail}")

    if not vstream:
        raise SystemExit("no video stream")
    w, h = vstream["width"], vstream["height"]
    check("resolution", (w, h) == (EXPECT_W, EXPECT_H), f"{w}x{h}", fatal=True)

    num, den = (vstream.get("r_frame_rate") or "0/1").split("/")
    fps = float(num) / float(den or 1)
    check("framerate", 29.0 <= fps <= 31.0, f"{fps:.2f} fps")

    duration = float(meta["format"]["duration"])
    expected = float(words["duration"])
    drift = duration - expected
    check(
        "duration_vs_narration",
        abs(drift) <= DURATION_TOLERANCE,
        f"video {duration:.2f}s vs narration {expected:.2f}s (drift {drift:+.2f}s)",
        fatal=True,
    )

    check("audio_stream", astream is not None, astream["codec_name"] if astream else "missing",
          fatal=True)

    vol = ffmpeg_stderr(["-i", str(video), "-af", "volumedetect", "-f", "null", "-"])
    mean = re.search(r"mean_volume:\s*(-?[\d.]+) dB", vol)
    peak = re.search(r"max_volume:\s*(-?[\d.]+) dB", vol)
    mean_db = float(mean.group(1)) if mean else -99.0
    peak_db = float(peak.group(1)) if peak else -99.0
    check("audio_level", mean_db >= MIN_MEAN_DB, f"mean {mean_db:.1f} dB", fatal=True)
    check("no_clipping", peak_db <= MAX_PEAK_DB, f"peak {peak_db:.1f} dB")

    black = ffmpeg_stderr(
        ["-i", str(video), "-vf", "blackdetect=d=0.4:pix_th=0.10", "-an", "-f", "null", "-"]
    )
    black_spans = re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", black)
    check(
        "no_dead_frames",
        not black_spans,
        f"{len(black_spans)} black span(s)" + (f" at {black_spans[0][0]}s" if black_spans else ""),
    )

    frames_dir = wd / "frames"
    frames_dir.mkdir(exist_ok=True)
    for old in frames_dir.glob("frame-*.jpg"):
        old.unlink()
    for i in range(N_FRAMES):
        # Sample inside the body of the video, skipping the very first/last frame.
        t = duration * (i + 0.5) / N_FRAMES
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.2f}",
             "-i", str(video), "-frames:v", "1", "-q:v", "3",
             str(frames_dir / f"frame-{i + 1}.jpg")],
            check=True,
        )

    failures = [c for c in checks if not c["ok"]]
    fatal = [c for c in failures if c["fatal"]]
    report = {
        "video": str(video.relative_to(wd)),
        "duration": duration,
        "narration_duration": expected,
        "resolution": f"{w}x{h}",
        "fps": round(fps, 2),
        "mean_db": mean_db,
        "peak_db": peak_db,
        "size_mb": round(video.stat().st_size / 1e6, 2),
        "frames": sorted(str(p.relative_to(wd)) for p in frames_dir.glob("frame-*.jpg")),
        "checks": checks,
        "passed": not failures,
    }
    write_json("quality.json", report)

    print(json.dumps({
        "passed": not failures,
        "fatal": len(fatal),
        "warnings": len(failures) - len(fatal),
        "duration": round(duration, 2),
        "resolution": f"{w}x{h}",
    }))

    if fatal:
        raise SystemExit(
            "fatal QC failures: " + "; ".join(f"{c['check']} ({c['detail']})" for c in fatal)
        )


if __name__ == "__main__":
    main()
