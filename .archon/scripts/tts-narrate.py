"""Narrate the brief with Cartesia, capturing word-level timestamps.

Because Cartesia returns word timings alongside the audio, there is no
transcription stage: no Whisper model, no STT provider, and no risk of the
captions disagreeing with a script we already know verbatim.

Reads  : brief.json           (narration)
Writes : narration.wav, words.json
"""

from __future__ import annotations

import base64
import json

import requests

from _common import load_env, log, read_json, require_key, run, work_dir, write_json

API = "https://api.cartesia.ai/tts/sse"
API_VERSION = "2026-03-01"
MODEL = "sonic-3.5"
DEFAULT_VOICE = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"  # Skylar - Friendly Guide
SAMPLE_RATE = 44100


def main() -> None:
    env = load_env()
    key = require_key(env, "CARTESIA_API_KEY")
    brief = read_json("brief.json")

    transcript = (brief.get("narration") or "").strip()
    if not transcript:
        raise SystemExit("brief.json has no narration")
    voice = brief.get("voice_id") or env.get("CARTESIA_VOICE_ID") or DEFAULT_VOICE

    log(f"synthesising {len(transcript.split())} words with {MODEL}")
    resp = requests.post(
        API,
        headers={
            "X-API-Key": key,
            "Cartesia-Version": API_VERSION,
            "Content-Type": "application/json",
        },
        json={
            "model_id": MODEL,
            "transcript": transcript,
            "voice": {"mode": "id", "id": voice},
            # SSE only serves raw PCM; ffmpeg gives it a container below.
            "output_format": {
                "container": "raw",
                "encoding": "pcm_f32le",
                "sample_rate": SAMPLE_RATE,
            },
            "language": "en",
            "add_timestamps": True,
        },
        timeout=180,
        stream=True,
    )
    if not resp.ok:
        raise SystemExit(f"Cartesia returned {resp.status_code}: {resp.text[:400]}")

    pcm = bytearray()
    words: list[dict] = []
    for line in resp.iter_lines():
        if not line or not line.startswith(b"data:"):
            continue
        try:
            event = json.loads(line[5:].strip())
        except json.JSONDecodeError:
            continue
        kind = event.get("type")
        if kind == "chunk":
            pcm += base64.b64decode(event["data"])
        elif kind == "timestamps":
            wt = event.get("word_timestamps", {})
            words += [
                {"word": w, "start": s, "end": e}
                for w, s, e in zip(wt.get("words", []), wt.get("start", []), wt.get("end", []))
            ]
        elif kind == "error":
            raise SystemExit(f"Cartesia stream error: {event.get('error')}")

    if not pcm:
        raise SystemExit("Cartesia returned no audio")
    if not words:
        raise SystemExit("Cartesia returned no word timestamps — captions would be guesswork")

    wd = work_dir()
    raw = wd / "narration.pcm"
    raw.write_bytes(bytes(pcm))
    wav = wd / "narration.wav"
    run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", str(raw),
            "-c:a", "pcm_s16le", str(wav),
        ]
    )
    raw.unlink()

    duration = len(pcm) / 4 / SAMPLE_RATE
    write_json(
        "words.json",
        {"duration": duration, "voice_id": voice, "model": MODEL, "words": words},
    )
    print(f"narration {duration:.2f}s, {len(words)} word timings")


if __name__ == "__main__":
    main()
