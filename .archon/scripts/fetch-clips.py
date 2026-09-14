"""Download portrait stock clips from Pexels for the current brief.

Reads  : brief.json           (keywords)
Writes : clips/NN-<id>.mp4, clips.json
"""

from __future__ import annotations

import requests

from _common import load_env, log, read_json, require_key, work_dir, write_json

MAX_CLIPS = 8
TARGET_W, TARGET_H = 1080, 1920


def pick_file(video: dict) -> dict | None:
    """Prefer the smallest portrait rendition that still covers 1080x1920."""
    portrait = [f for f in video["video_files"] if f.get("height", 0) > f.get("width", 0)]
    if not portrait:
        return None
    covering = [f for f in portrait if f["height"] >= TARGET_H and f["width"] >= TARGET_W]
    if covering:
        return min(covering, key=lambda f: f["width"] * f["height"])
    return max(portrait, key=lambda f: f["width"] * f["height"])


def main() -> None:
    env = load_env()
    key = require_key(env, "PEXELS_API_KEY")
    brief = read_json("brief.json")
    keywords: list[str] = [k for k in brief.get("keywords", []) if k.strip()]
    if not keywords:
        raise SystemExit("brief.json has no keywords")

    out_dir = work_dir() / "clips"
    out_dir.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    session.headers["Authorization"] = key

    manifest: list[dict] = []
    seen: set[int] = set()

    for kw in keywords:
        if len(manifest) >= MAX_CLIPS:
            break
        try:
            r = session.get(
                "https://api.pexels.com/videos/search",
                params={
                    "query": kw,
                    "per_page": 8,
                    "orientation": "portrait",
                    "size": "medium",
                },
                timeout=30,
            )
            r.raise_for_status()
        except requests.RequestException as err:
            # One dead keyword shouldn't sink the run — but say so loudly.
            log(f"WARN  search failed for {kw!r}: {err}")
            continue

        for video in r.json().get("videos", []):
            if video["id"] in seen:
                continue
            # Very short clips produce visible stutter once looped to fill a segment.
            if video.get("duration", 0) < 5:
                continue
            f = pick_file(video)
            if not f:
                continue

            dest = out_dir / f"{len(manifest):02d}-{video['id']}.mp4"
            try:
                with session.get(f["link"], stream=True, timeout=120) as resp:
                    resp.raise_for_status()
                    with dest.open("wb") as fh:
                        for chunk in resp.iter_content(1 << 16):
                            fh.write(chunk)
            except requests.RequestException as err:
                log(f"WARN  download failed for video {video['id']}: {err}")
                dest.unlink(missing_ok=True)
                continue

            seen.add(video["id"])
            manifest.append(
                {
                    "keyword": kw,
                    "pexels_id": video["id"],
                    "path": str(dest.relative_to(work_dir())),
                    "duration": video["duration"],
                    "width": f["width"],
                    "height": f["height"],
                    "credit": video.get("user", {}).get("name", "unknown"),
                    "url": video.get("url", ""),
                }
            )
            log(f"  got {kw!r} -> {dest.name} ({f['width']}x{f['height']}, {video['duration']}s)")
            break  # one clip per keyword keeps the visuals varied

    if not manifest:
        raise SystemExit("no usable portrait clips found for any keyword")

    write_json("clips.json", manifest)
    print(f"downloaded {len(manifest)} clips")


if __name__ == "__main__":
    main()
