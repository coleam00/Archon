"""Assemble clips + narration + music + captions into the finished short.

One ffmpeg invocation does the whole job: each clip is looped to fill its
segment, cropped to 1080x1920, concatenated, captioned, and mixed against a
ducked music bed.

Reads  : clips.json, words.json, narration.wav, captions.ass, brief.json
Writes : video.mp4
"""

from __future__ import annotations

import os
import pathlib
import random

from _common import ROOT, log, read_json, run, work_dir

OUT_W, OUT_H, FPS = 1080, 1920, 30
SECONDS_PER_CLIP = 4.0      # preferred visual cut cadence
MAX_SECONDS_PER_CLIP = 6.5  # slower than this and a shot starts to drag
TAIL_PADDING = 0.45         # breathing room after the last word
MUSIC_VOLUME = 0.10


def pick_music() -> pathlib.Path | None:
    d = ROOT / "assets" / "music"
    tracks = sorted(p for p in d.glob("*") if p.suffix.lower() in {".mp3", ".wav", ".m4a"})
    return random.choice(tracks) if tracks else None


def main() -> None:
    wd = work_dir()
    clips = read_json("clips.json")
    words = read_json("words.json")

    narration = wd / "narration.wav"
    captions = wd / "captions.ass"
    for required in (narration, captions):
        if not required.exists():
            raise SystemExit(f"missing {required}")

    total = float(words["duration"]) + TAIL_PADDING
    ideal = max(1, round(total / SECONDS_PER_CLIP))
    if len(clips) >= ideal:
        chosen = clips[:ideal]
    elif total / len(clips) <= MAX_SECONDS_PER_CLIP:
        # Slightly longer shots beat showing the same footage twice.
        chosen = list(clips)
    else:
        # Genuinely not enough footage — cycle, and say so.
        chosen = [clips[i % len(clips)] for i in range(ideal)]
        log(f"WARN  only {len(clips)} clips for {ideal} segments — footage will repeat")
    seg = total / len(chosen)
    log(f"composing {total:.2f}s from {len(chosen)} segments of {seg:.2f}s")

    music = pick_music()
    args: list[str] = ["ffmpeg", "-y", "-loglevel", "error"]
    for clip in chosen:
        args += ["-stream_loop", "-1", "-t", f"{seg:.3f}", "-i", str(wd / clip["path"])]
    args += ["-i", str(narration)]
    narration_idx = len(chosen)
    if music:
        log(f"music bed: {music.name}")
        args += ["-stream_loop", "-1", "-i", str(music)]

    parts: list[str] = []
    for i in range(len(chosen)):
        parts.append(
            f"[{i}:v]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,"
            f"crop={OUT_W}:{OUT_H},fps={FPS},setsar=1,format=yuv420p[v{i}]"
        )
    parts.append("".join(f"[v{i}]" for i in range(len(chosen)))
                 + f"concat=n={len(chosen)}:v=1:a=0[vcat]")
    # ass= takes a bare filename; we chdir to the work dir so no path escaping is needed.
    parts.append(f"[vcat]ass={captions.name}[vout]")

    if music:
        parts.append(f"[{narration_idx}:a]aresample=44100,volume=1.0[na]")
        parts.append(
            f"[{narration_idx + 1}:a]aresample=44100,volume={MUSIC_VOLUME},"
            f"afade=t=out:st={max(0.0, total - 1.2):.3f}:d=1.2[ma]"
        )
        parts.append("[na][ma]amix=inputs=2:duration=first:dropout_transition=0,"
                     "alimiter=limit=0.89:level=disabled[aout]")
    else:
        parts.append(f"[{narration_idx}:a]aresample=44100,alimiter=limit=0.89:level=disabled[aout]")

    out = wd / "video.mp4"
    args += [
        "-filter_complex", ";".join(parts),
        "-map", "[vout]", "-map", "[aout]",
        "-t", f"{total:.3f}",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(out),
    ]

    cwd = os.getcwd()
    try:
        os.chdir(wd)
        run(args)
    finally:
        os.chdir(cwd)

    size_mb = out.stat().st_size / 1e6
    print(f"video.mp4 {size_mb:.1f}MB, {total:.2f}s, {len(chosen)} segments")


if __name__ == "__main__":
    main()
